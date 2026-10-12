import * as t from "@babel/types";

import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type {
  ElectronApiIdentity,
  ElectronStaticValue,
} from "./electronStaticAnalysisTypes.js";
import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { sourceSlice } from "./javascriptStaticAnalysisHelpers.js";
import type {
  ElectronApiObject,
  JavaScriptFindingContext,
} from "./javascriptStaticAnalysisState.js";

/** Resolve a callee only when its root has a classified Electron identity. */
export const electronCallee = (
  callee: t.Node,
  context: JavaScriptFindingContext,
):
  | {
      readonly path: readonly string[];
      readonly identity: ElectronApiIdentity;
    }
  | undefined => {
  const members: string[] = [];
  let root = callee;
  while (t.isMemberExpression(root) || t.isOptionalMemberExpression(root)) {
    const member = semanticStaticPropertyName(root.property, root.computed);
    if (member === "" || !t.isNode(root.object)) return undefined;
    members.push(member);
    root = root.object;
  }
  const binding = context.electron?.callees.get(root.start ?? -1);
  return binding === undefined
    ? undefined
    : {
        path: [
          ...binding.path,
          ...members.toReversed().slice(binding.consumed_members),
        ],
        identity: binding.identity,
      };
};

/** Preserve one literal or derived value, or the exact inert expression. */
export const electronStaticValue = (
  context: JavaScriptFindingContext,
  node: t.Node | null | undefined,
): ElectronStaticValue => {
  const constant = context.constants(node);
  if (constant.status === "literal")
    return { status: "literal", value: constant.value, expression: null };
  const expression = boundedExpression(context.source, node);
  return constant.status === "derived"
    ? { status: "derived", value: constant.value, expression }
    : { status: "dynamic", value: null, expression };
};

/** Return an actionable expression without evaluating it. */
export const boundedExpression = (
  source: string,
  node: t.Node | null | undefined,
): string => {
  if (node === null || node === undefined) return "[missing-expression]";
  const expression = sourceSlice(source, node).trim();
  return expression === "" ? `[${node.type}]` : expression;
};

/** Find the effective explicit property, preserving unresolved overrides. */
export const objectProperty = (
  object: t.Node | undefined,
  name: string,
):
  | { readonly status: "missing" | "dynamic" }
  | { readonly status: "explicit"; readonly property: t.ObjectProperty } => {
  if (object === undefined) return { status: "missing" };
  if (!t.isObjectExpression(object)) return { status: "dynamic" };
  for (const property of object.properties.toReversed()) {
    if (t.isSpreadElement(property)) return { status: "dynamic" };
    const key = semanticStaticPropertyName(property.key, property.computed);
    if (key === "" && !t.isStringLiteral(property.key))
      return { status: "dynamic" };
    if (key !== name) continue;
    return t.isObjectProperty(property)
      ? { status: "explicit", property }
      : { status: "dynamic" };
  }
  return { status: "missing" };
};

type PresentHandlerKind =
  | "inline-function"
  | "identifier"
  | "member-expression"
  | "dynamic-expression";

/** Classify a handler argument while retaining its exact source range. */
export function handlerKind(node: t.Node): PresentHandlerKind;
export function handlerKind(node: null | undefined): "missing";
export function handlerKind(
  node: t.Node | null | undefined,
): PresentHandlerKind | "missing" {
  if (node === null || node === undefined) return "missing";
  if (
    t.isArrowFunctionExpression(node) ||
    t.isFunctionExpression(node) ||
    t.isFunctionDeclaration(node)
  )
    return "inline-function";
  if (t.isIdentifier(node)) return "identifier";
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    return "member-expression";
  return "dynamic-expression";
}

/** Statically visible dotted keys of one contextBridge API argument. */
export interface ContextBridgeMembers {
  readonly status: "object-literal" | "object-binding" | "dynamic" | "missing";
  readonly members: readonly string[];
  /** Keys present only in one branch of a conditional object spread. */
  readonly conditional_members: readonly string[];
  readonly unknown: number;
}

/**
 * Collect keys from an object literal or an identifier bound to one, following
 * member values that are bound identifiers. A visible member write to a bound
 * object adds one unknown, since its added keys are not enumerated.
 */
export const collectContextBridgeMembers = (
  node: t.Node | null | undefined,
  objects: ReadonlyMap<number, ElectronApiObject> | undefined,
): ContextBridgeMembers => {
  if (node === null || node === undefined)
    return {
      status: "missing",
      members: [],
      conditional_members: [],
      unknown: 0,
    };
  const state: MemberState = {
    members: [],
    conditional: [],
    unknown: 0,
    objects: objects ?? new Map(),
  };
  const root = boundObject(node, state);
  if (root === undefined)
    return {
      status: "dynamic",
      members: [],
      conditional_members: [],
      unknown: 1,
    };
  collectMembersAt(root, "", 0, false, state);
  const members = new Set(state.members);
  return {
    status: t.isObjectExpression(node) ? "object-literal" : "object-binding",
    members: [...members].sort(compareUnicodeCodePoints),
    conditional_members: [...new Set(state.conditional)]
      .filter((member) => !members.has(member))
      .sort(compareUnicodeCodePoints),
    unknown: state.unknown,
  };
};

interface MemberState {
  readonly members: string[];
  readonly conditional: string[];
  unknown: number;
  readonly objects: ReadonlyMap<number, ElectronApiObject>;
}

const boundObject = (
  node: t.Node,
  state: MemberState,
): t.ObjectExpression | undefined => {
  const expression = unwrapJavaScriptExpression(node).node;
  if (t.isObjectExpression(expression)) return expression;
  const bound = state.objects.get(expression.start ?? -1);
  if (bound === undefined || !t.isIdentifier(expression)) return undefined;
  if (bound.memberWrites) state.unknown += 1;
  return bound.object;
};

const collectMembersAt = (
  object: t.ObjectExpression,
  prefix: string,
  depth: number,
  conditional: boolean,
  state: MemberState,
): void => {
  if (depth >= 8) {
    state.unknown += 1;
    return;
  }
  for (const property of object.properties) {
    if (t.isSpreadElement(property)) {
      collectSpread(property.argument, prefix, depth, conditional, state);
      continue;
    }
    const name = semanticStaticPropertyName(property.key, property.computed);
    if (name === "" || property.computed) {
      state.unknown += 1;
      continue;
    }
    const path = prefix === "" ? name : `${prefix}.${name}`;
    (conditional ? state.conditional : state.members).push(path);
    const nested = t.isObjectProperty(property)
      ? boundObject(property.value, state)
      : undefined;
    if (nested !== undefined)
      collectMembersAt(nested, path, depth + 1, conditional, state);
  }
};

// A spread contributes exact keys only when every branch is a known object.
const collectSpread = (
  argument: t.Node,
  prefix: string,
  depth: number,
  conditional: boolean,
  state: MemberState,
): void => {
  const expression = unwrapJavaScriptExpression(argument).node;
  const branches = t.isConditionalExpression(expression)
    ? [expression.consequent, expression.alternate]
    : t.isLogicalExpression(expression)
      ? [expression.left, expression.right]
      : [expression];
  const objects = branches.map((branch) => boundObject(branch, state));
  if (objects.some((object) => object === undefined)) {
    state.unknown += 1;
    return;
  }
  for (const object of objects)
    if (object !== undefined)
      collectMembersAt(
        object,
        prefix,
        depth,
        conditional || branches.length > 1,
        state,
      );
};

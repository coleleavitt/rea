import * as t from "@babel/types";

import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { ElectronStaticValue } from "./electronStaticAnalysisTypes.js";
import { semanticStaticPropertyName } from "./javascriptAstValues.js";
import { sourceSlice } from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

/** Resolve a callee only when its root has a proven Electron module identity. */
export const electronCalleePath = (
  callee: t.Node,
  context: JavaScriptFindingContext,
): readonly string[] | undefined => {
  const members: string[] = [];
  let root = callee;
  while (t.isMemberExpression(root) || t.isOptionalMemberExpression(root)) {
    const member = semanticStaticPropertyName(root.property, root.computed);
    if (member === "" || !t.isNode(root.object)) return undefined;
    members.push(member);
    root = root.object;
  }
  const exported = context.electronBindings?.get(root.start ?? -1);
  return exported === undefined
    ? undefined
    : [...exported, ...members.toReversed()];
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

/** Collect statically visible dotted keys from one literal contextBridge API object. */
export const collectContextBridgeMembers = (
  node: t.Node | null | undefined,
): {
  readonly status: "object-literal" | "dynamic" | "missing";
  readonly members: readonly string[];
  readonly unknown: number;
} => {
  if (node === null || node === undefined)
    return {
      status: "missing",
      members: [],
      unknown: 0,
    };
  if (!t.isObjectExpression(node))
    return {
      status: "dynamic",
      members: [],
      unknown: 1,
    };
  const state: { members: string[]; unknown: number } = {
    members: [],
    unknown: 0,
  };
  collectMembersAt(node, "", 0, state);
  const members = [...new Set(state.members)].sort(compareUnicodeCodePoints);
  return {
    status: "object-literal",
    members,
    unknown: state.unknown,
  };
};

const collectMembersAt = (
  object: t.ObjectExpression,
  prefix: string,
  depth: number,
  state: { members: string[]; unknown: number },
): void => {
  if (depth >= 8) {
    state.unknown += 1;
    return;
  }
  for (const property of object.properties) {
    if (t.isSpreadElement(property)) {
      state.unknown += 1;
      continue;
    }
    const name = semanticStaticPropertyName(property.key, property.computed);
    if (name === "" || property.computed) {
      state.unknown += 1;
      continue;
    }
    const path = prefix === "" ? name : `${prefix}.${name}`;
    state.members.push(path);
    if (t.isObjectProperty(property) && t.isObjectExpression(property.value))
      collectMembersAt(property.value, path, depth + 1, state);
  }
};

import * as t from "@babel/types";

import type {
  ElectronApiIdentity,
  ElectronCalleeBinding,
} from "./electronStaticAnalysisTypes.js";
import { electronMemberPath } from "./javascriptElectronMemberWrites.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { compositeKey } from "../unicodeCodePointOrder.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import {
  resolveSemanticBindingState,
  semanticScopeId,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";

type WrapperIdentity = Extract<
  ElectronApiIdentity,
  { readonly basis: "wrapper-parameter" }
>;

/** One parameter position of a named function, with its destructuring keys. */
interface WrapperParameter {
  readonly wrapper: t.Function;
  readonly functionName: string;
  readonly functionBinding: JavaScriptSemanticBindingState;
  readonly parameter: string;
  readonly index: number;
  readonly projection: readonly string[];
  readonly fallback: t.Expression | undefined;
}

interface DeferredRoot {
  readonly root: t.Identifier;
  readonly members: readonly string[];
  readonly parameter: WrapperParameter;
}

interface ArgumentOutcome {
  readonly path: readonly string[] | undefined;
  readonly location: t.Node;
}

/**
 * Infer Electron API identity for callee roots that are local bindings whose
 * stable initializer is a `??`, `||`, `&&`, conditional, or object literal of
 * Electron values, and for roots that are parameters of one
 * named wrapper function. Only same-file direct calls are examined, and only
 * one wrapper level: argument expressions must be proven Electron exports, an
 * object literal member holding one, or a `??`, `||`, `&&` or conditional
 * branch of those. Every other argument stays an explicit unresolved count.
 *
 * This is a summary over all call sites. Symbolic call-path substitution binds
 * each call site's own arguments and reads this summary only for a parameter
 * that no call site on its path binds. The summary cannot reuse that
 * substitution: it belongs to the identity index the substitution reads, and
 * it records proving argument locations that substituted values do not carry.
 */
export const createElectronWrapperParameters = (
  state: JavaScriptSemanticAnalysisState,
  rootExport: (root: t.Node) => readonly string[] | undefined,
) => {
  const deferred: DeferredRoot[] = [];
  const parameters = new Map<string, WrapperParameter | null>();
  const callSites = new Map<string, t.CallExpression["arguments"][]>();
  const escaped = new Set<string>();
  const locals: {
    readonly root: t.Identifier;
    readonly members: readonly string[];
    readonly initializer: t.Expression;
  }[] = [];

  const parameterFor = (
    root: t.Identifier,
    binding: JavaScriptSemanticBindingState,
  ): WrapperParameter | undefined => {
    const cached = parameters.get(binding.bindingId);
    if (cached !== undefined) return cached ?? undefined;
    const found = locateParameter(root, binding, state);
    parameters.set(binding.bindingId, found ?? null);
    return found;
  };

  return {
    /** Retain a call root whose identity may come from wrapper call sites. */
    defer: (root: t.Node, members: readonly (string | null)[]): void => {
      if (!t.isIdentifier(root)) return;
      if (!members.every((member): member is string => member !== null)) return;
      const binding = resolveSemanticBindingState(state, root, root.name);
      const local = semanticStableInitializer(binding, state);
      const alternatives =
        local?.projection.length === 0
          ? unwrapJavaScriptExpression(local.node).node
          : undefined;
      if (
        t.isLogicalExpression(alternatives) ||
        t.isConditionalExpression(alternatives) ||
        t.isObjectExpression(alternatives)
      ) {
        locals.push({ root, members, initializer: alternatives });
        return;
      }
      if (
        binding?.kind !== "parameter" ||
        binding.definitions.length !== 1 ||
        binding.definitions[0]?.kind !== "parameter"
      )
        return;
      const parameter = parameterFor(root, binding);
      if (parameter !== undefined) deferred.push({ root, members, parameter });
    },

    /** Collect direct calls and other references of the deferred wrappers. */
    *collectCallSitesSteps(program: t.Program): Generator<void> {
      if (deferred.length === 0) return;
      const wrappers = new Map<string, WrapperParameter>();
      for (const { parameter } of deferred)
        wrappers.set(parameter.functionBinding.bindingId, parameter);
      const names = new Set(
        [...wrappers.values()].map(({ functionName }) => functionName),
      );
      yield* traverseJavaScriptAstSteps(program, {
        enter: (node) => {
          if (!t.isIdentifier(node) || !names.has(node.name)) return;
          const parent = state.parentsByNode.get(node);
          if (parent === undefined || !isReference(node, parent, state)) return;
          const binding = resolveSemanticBindingState(state, node, node.name);
          if (binding === undefined) return;
          const wrapper = wrappers.get(binding.bindingId);
          if (wrapper === undefined) return;
          if (
            (t.isCallExpression(parent) || t.isNewExpression(parent)) &&
            parent.callee === node
          ) {
            const sites = callSites.get(binding.bindingId) ?? [];
            sites.push(parent.arguments);
            callSites.set(binding.bindingId, sites);
          } else escaped.add(binding.bindingId);
        },
      });
    },

    /** Resolve each deferred root whose call-site arguments agree on one export. */
    *resolved(): Generator<{
      readonly root: t.Identifier;
      readonly binding: ElectronCalleeBinding;
    }> {
      for (const { root, members, initializer } of locals) {
        const outcomes = expressionOutcomes(initializer, members, rootExport);
        const proven = agreedOutcomes(outcomes);
        const [path] = proven;
        if (path === undefined) continue;
        yield {
          root,
          binding: {
            path: path.path,
            consumed_members: members.length,
            identity: {
              basis: "local-alternatives",
              binding: root.name,
              initializer_location: range(initializer),
              electron_value_locations: proven.map(({ location }) =>
                range(location),
              ),
              unresolved_values: outcomes.length - proven.length,
            },
          },
        };
      }
      for (const { root, members, parameter } of deferred) {
        const bindingId = parameter.functionBinding.bindingId;
        const sites = callSites.get(bindingId) ?? [];
        const wanted = [...parameter.projection, ...members];
        const outcomes = sites.flatMap((arguments_) =>
          argumentOutcomes(arguments_, parameter, wanted, rootExport),
        );
        const proven = agreedOutcomes(outcomes);
        const [path] = proven;
        if (path === undefined) continue;
        // The callee path is the resolved argument path; the callee members
        // already folded into it are consumed rather than appended again.
        const identity: WrapperIdentity = {
          basis: "wrapper-parameter",
          function_name: parameter.functionName,
          parameter: parameter.parameter,
          parameter_index: parameter.index,
          function_location: range(parameter.wrapper),
          call_sites: sites.length,
          call_sites_complete: !escaped.has(bindingId),
          electron_argument_locations: proven.map(({ location }) =>
            range(location),
          ),
          unresolved_arguments: outcomes.length - proven.length,
        };
        yield {
          root,
          binding: {
            path: path.path,
            consumed_members: members.length,
            identity,
          },
        };
      }
    },
  };
};

// Proven outcomes, only when they all name the same Electron export.
const agreedOutcomes = (
  outcomes: readonly ArgumentOutcome[],
): readonly (ArgumentOutcome & { readonly path: readonly string[] })[] => {
  const proven = outcomes.filter(
    (outcome): outcome is ArgumentOutcome & { path: readonly string[] } =>
      outcome.path !== undefined,
  );
  return new Set(proven.map(({ path }) => compositeKey(path))).size === 1
    ? proven
    : [];
};

const argumentOutcomes = (
  arguments_: t.CallExpression["arguments"],
  parameter: WrapperParameter,
  wanted: readonly string[],
  rootExport: (root: t.Node) => readonly string[] | undefined,
): readonly ArgumentOutcome[] => {
  const opaque = arguments_
    .slice(0, parameter.index + 1)
    .find((argument) => t.isSpreadElement(argument));
  if (opaque !== undefined) return [{ path: undefined, location: opaque }];
  const argument = arguments_[parameter.index];
  if (argument === undefined || t.isArgumentPlaceholder(argument))
    return parameter.fallback === undefined
      ? [{ path: undefined, location: parameter.wrapper }]
      : expressionOutcomes(parameter.fallback, wanted, rootExport);
  if (!t.isExpression(argument))
    return [{ path: undefined, location: argument }];
  return expressionOutcomes(argument, wanted, rootExport);
};

const expressionOutcomes = (
  node: t.Expression,
  wanted: readonly string[],
  rootExport: (root: t.Node) => readonly string[] | undefined,
): readonly ArgumentOutcome[] => {
  const expression = unwrapJavaScriptExpression(node).node;
  if (t.isLogicalExpression(expression))
    return [
      ...expressionOutcomes(expression.left, wanted, rootExport),
      ...expressionOutcomes(expression.right, wanted, rootExport),
    ];
  if (t.isConditionalExpression(expression))
    return [
      ...expressionOutcomes(expression.consequent, wanted, rootExport),
      ...expressionOutcomes(expression.alternate, wanted, rootExport),
    ];
  const [key, ...rest] = wanted;
  if (t.isObjectExpression(expression) && key !== undefined) {
    const member = objectLiteralMember(expression, key);
    return member === undefined
      ? [{ path: undefined, location: expression }]
      : expressionOutcomes(member, rest, rootExport);
  }
  const { root, members } = electronMemberPath(expression);
  const exported = members.every((member): member is string => member !== null)
    ? rootExport(root)
    : undefined;
  return [
    {
      path:
        exported === undefined
          ? undefined
          : [...exported, ...(members as readonly string[]), ...wanted],
      location: expression,
    },
  ];
};

// The effective value of one key in an object literal, when it is exact.
const objectLiteralMember = (
  object: t.ObjectExpression,
  key: string,
): t.Expression | undefined => {
  for (const property of object.properties.toReversed()) {
    if (t.isSpreadElement(property)) return undefined;
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) return undefined;
    if (name !== key) continue;
    return t.isObjectProperty(property) && t.isExpression(property.value)
      ? property.value
      : undefined;
  }
  return undefined;
};

const locateParameter = (
  root: t.Identifier,
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): WrapperParameter | undefined => {
  let current: t.Node | undefined = state.parentsByNode.get(root);
  while (
    current !== undefined &&
    !(
      t.isFunction(current) &&
      semanticScopeId("function", current) === binding.scopeId
    )
  )
    current = state.parentsByNode.get(current);
  if (current === undefined || !t.isFunction(current)) return undefined;
  const wrapper = current;
  const named = wrapperName(wrapper, state);
  if (named === undefined) return undefined;
  for (const [index, parameter] of wrapper.params.entries()) {
    const position = parameterPosition(parameter, binding.name);
    if (position !== undefined)
      return {
        wrapper,
        functionName: named.name,
        functionBinding: named.binding,
        parameter: binding.name,
        index,
        ...position,
      };
  }
  return undefined;
};

const parameterPosition = (
  parameter: t.Function["params"][number],
  name: string,
):
  | {
      readonly projection: readonly string[];
      readonly fallback: t.Expression | undefined;
    }
  | undefined => {
  if (t.isIdentifier(parameter))
    return parameter.name === name
      ? { projection: [], fallback: undefined }
      : undefined;
  if (t.isAssignmentPattern(parameter) && t.isIdentifier(parameter.left))
    return parameter.left.name === name
      ? { projection: [], fallback: parameter.right }
      : undefined;
  if (!t.isObjectPattern(parameter)) return undefined;
  for (const property of parameter.properties) {
    if (t.isRestElement(property)) continue;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (key !== null && t.isIdentifier(property.value, { name }))
      return { projection: [key], fallback: undefined };
  }
  return undefined;
};

const wrapperName = (
  wrapper: t.Function,
  state: JavaScriptSemanticAnalysisState,
):
  | {
      readonly name: string;
      readonly binding: JavaScriptSemanticBindingState;
    }
  | undefined => {
  const declarator = state.parentsByNode.get(wrapper);
  const id = t.isFunctionDeclaration(wrapper)
    ? wrapper.id
    : t.isVariableDeclarator(declarator) && declarator.init === wrapper
      ? declarator.id
      : undefined;
  if (!t.isIdentifier(id)) return undefined;
  const binding = resolveSemanticBindingState(state, id, id.name);
  const initializer = semanticStableInitializer(binding, state);
  return binding !== undefined &&
    initializer?.node === wrapper &&
    initializer.projection.length === 0
    ? { name: id.name, binding }
    : undefined;
};

// Declaration identifiers and property keys are not references.
const isReference = (
  node: t.Identifier,
  parent: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => t.isReferenced(node, parent, state.parentsByNode.get(parent));

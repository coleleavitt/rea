import * as t from "@babel/types";

import { semanticStaticPropertyKey } from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

/**
 * The key of `globalThis[Symbol.for(key)]` when both globals are unshadowed.
 * `Symbol.for` keys share one registry per realm, so sources loaded into one
 * realm reach the same slot through the same key.
 */
export const globalSymbolRegistryKey = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined => {
  if (!t.isMemberExpression(node) || !node.computed) return undefined;
  const { object, property } = node;
  if (
    !t.isIdentifier(object, { name: "globalThis" }) ||
    !unbound(object, state)
  )
    return undefined;
  if (!t.isCallExpression(property) || property.arguments.length !== 1)
    return undefined;
  const [key] = property.arguments;
  const callee = property.callee;
  return t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object, { name: "Symbol" }) &&
    unbound(callee.object, state) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === "for" &&
    t.isStringLiteral(key)
    ? key.value
    : undefined;
};

/**
 * Values a source publishes at load: top-level `globalThis[Symbol.for(key)] =
 * value` statements. A key published more than once maps to null.
 */
export const globalSymbolRegistryPublications = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): ReadonlyMap<string, t.Expression | null> => {
  const published = new Map<string, t.Expression | null>();
  for (const statement of program.body) {
    if (!t.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (!t.isAssignmentExpression(expression, { operator: "=" })) continue;
    const key = globalSymbolRegistryKey(expression.left, state);
    if (key === undefined) continue;
    published.set(key, published.has(key) ? null : expression.right);
  }
  return published;
};

// Candidate selection before parsing; the parsed syntax decides every link.
const REGISTRY_KEY =
  /globalThis\s*\[\s*Symbol\s*\.\s*for\s*\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')\s*\)\s*\]/gu;

/** Registry keys a source text may name, used only to select candidate sources to parse. */
export const globalSymbolRegistryCandidateKeys = (
  text: string,
): ReadonlySet<string> =>
  new Set(
    [...text.matchAll(REGISTRY_KEY)].flatMap((match) => {
      const key = match[1] ?? match[2];
      return key === undefined ? [] : [key];
    }),
  );

/**
 * For each source, the other sources whose text names one of its candidate
 * registry keys. Linking then reads and publishes keys from parsed syntax.
 */
export const globalSymbolRegistryCompanions = <
  Source extends { readonly path: string; readonly text: string },
>(
  sources: readonly Source[],
): ReadonlyMap<string, readonly Source[]> => {
  const keyed = sources
    .map((source) => ({
      source,
      keys: globalSymbolRegistryCandidateKeys(source.text),
    }))
    .filter(({ keys }) => keys.size > 0);
  return new Map(
    keyed.map(({ source, keys }) => [
      source.path,
      keyed
        .filter(
          (other) =>
            other.source !== source &&
            [...other.keys].some((key) => keys.has(key)),
        )
        .map((other) => other.source),
    ]),
  );
};

const unbound = (
  node: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  resolveSemanticBindingState(state, node, node.name) === undefined &&
  !semanticResolutionBlocked(state, node, node.name);

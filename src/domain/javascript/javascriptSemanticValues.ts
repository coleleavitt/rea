import * as t from "@babel/types";

import {
  semanticCapturePosition,
  semanticEscapeFollowsCapture,
  semanticBindingPrecedesCapture,
} from "./javascriptSemanticMutationInitializers.js";

import { semanticSlotAtPath } from "./javascriptSemanticSlots.js";

import {
  invalidateSemanticEscapedPath,
  invalidateSemanticMutationPaths,
} from "./javascriptSemanticMutationValues.js";

import type { JavaScriptBindingProvenance } from "./javascriptSemanticIr.js";
import type {
  JavaScriptSemanticProperty,
  JavaScriptSemanticResourceLimit,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { semanticRequireOrigin } from "./javascriptSemanticRequireOrigin.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import {
  applySemanticBinaryOperator,
  applySemanticUnaryOperator,
  isFoldableSemanticBinaryOperator,
  semanticJoinText,
  semanticOperandValue,
  type JavaScriptSemanticOperand,
} from "./javascriptSemanticOperators.js";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticAmbiguousProvenance,
  semanticLocalProvenance,
  semanticOriginsProvenance,
  semanticUnresolvedProvenance,
  uniqueSemanticOrigins,
} from "./javascriptSemanticProvenance.js";
import {
  semanticPrimitiveCandidates as primitiveCandidates,
  semanticPrimitiveSet as primitiveSet,
} from "./javascriptSemanticPrimitives.js";
import {
  SEMANTIC_EXPRESSION_DEPTH_LIMIT,
  SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT,
  exceedsSemanticPrimitiveAdditionByteBudget,
  exceedsSemanticTemplateByteBudget,
  semanticResourceLimitUnknown,
  semanticResourceLimitReason,
} from "./javascriptSemanticResourceLimits.js";

interface EvaluationContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly bindings: Set<string>;
  readonly expressionDepth: number;
  readonly capturePoint?: t.Node;
  readonly primitiveBindingValues: Map<string, JavaScriptSemanticValue>;
}

const primitiveBindingValuesByState = new WeakMap<
  JavaScriptSemanticAnalysisState,
  Map<string, JavaScriptSemanticValue>
>();

const primitiveExpressionValuesByState = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, JavaScriptSemanticValue>
>();

const capturedBindingValuesByState = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, Map<string, JavaScriptSemanticValue>>
>();

/** Discard primitive projections evaluated before mutation collection finished. */
export const clearSemanticPrimitiveBindingValues = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  primitiveBindingValuesByState.delete(state);
  capturedBindingValuesByState.delete(state);
  primitiveExpressionValuesByState.delete(state);
};

const primitiveBindingValuesFor = (
  state: JavaScriptSemanticAnalysisState,
): Map<string, JavaScriptSemanticValue> => {
  const existing = primitiveBindingValuesByState.get(state);
  if (existing !== undefined) return existing;
  const values = new Map<string, JavaScriptSemanticValue>();
  primitiveBindingValuesByState.set(state, values);
  return values;
};

// Cap expression recursion independently from graph nodes and primitive unions.
const isSemanticResourceLimit = (
  value: JavaScriptSemanticValue,
): value is Extract<
  JavaScriptSemanticValue,
  { readonly status: "unknown" | "ambiguous" | "cycle" }
> & { readonly resourceLimit: JavaScriptSemanticResourceLimit } =>
  value.status === "unknown" && value.resourceLimit !== undefined;

/** Evaluate one binding in the bounded constant-value lattice. */
export const evaluateSemanticBinding = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticValue =>
  evaluateBinding(binding, {
    state,
    bindings: new Set(),
    expressionDepth: 0,
    primitiveBindingValues: primitiveBindingValuesFor(state),
  });

/** Evaluate an inert expression, optionally at an earlier reference capture. */
export const evaluateSemanticExpression = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  capturePoint?: t.Node,
): JavaScriptSemanticValue => {
  const context: EvaluationContext = {
    state,
    bindings: new Set(),
    expressionDepth: 0,
    primitiveBindingValues: primitiveBindingValuesFor(state),
  };
  return evaluateExpression(
    node,
    capturePoint === undefined
      ? context
      : (captureContextAt(capturePoint, context) ?? context),
  );
};

/** Follow module provenance through destructuring, members, and aliases. */
export const evaluateSemanticProvenance = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptBindingProvenance =>
  provenanceForBinding(binding, {
    state,
    bindings: new Set(),
    expressionDepth: 0,
    primitiveBindingValues: primitiveBindingValuesFor(state),
  });

const evaluateBinding = (
  binding: JavaScriptSemanticBindingState,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  if (context.bindings.has(binding.bindingId))
    return { status: "cycle", reason: `Alias cycle at ${binding.name}.` };
  if (
    context.capturePoint !== undefined &&
    !semanticBindingPrecedesCapture(
      binding,
      context.capturePoint,
      context.state.parentsByNode,
    )
  ) {
    const { capturePoint: _capturePoint, ...liveContext } = context;
    return evaluateBinding(binding, {
      ...liveContext,
      primitiveBindingValues: primitiveBindingValuesFor(context.state),
    });
  }
  const cached = context.primitiveBindingValues.get(binding.bindingId);
  if (cached !== undefined) return cached;
  if (binding.initializers.length === 0)
    return {
      status: "unknown",
      reason: `Binding ${binding.name} has no constant initializer.`,
    };
  if (
    binding.initializers.some(
      ({ node }) =>
        t.isUpdateExpression(node) ||
        (t.isAssignmentExpression(node) &&
          node.operator !== "=" &&
          node.operator !== "&&=" &&
          node.operator !== "||=" &&
          node.operator !== "??="),
    )
  )
    return {
      status: "unknown",
      reason: `Binding ${binding.name} has a compound or update write.`,
    };
  if (binding.initializers.length > 1)
    return {
      status: "ambiguous",
      reason: `Binding ${binding.name} has multiple possible assignments.`,
    };
  const initializer = binding.initializers[0];
  if (initializer === undefined)
    return { status: "unknown", reason: "Missing binding initializer." };
  context.bindings.add(binding.bindingId);
  let value: JavaScriptSemanticValue;
  try {
    const nested = nestedContext(context);
    value = projectValue(
      evaluateExpression(initializer.node, nested),
      initializer.projection,
    );
    if (!isPrimitive(value)) {
      const captureContext = primitiveCaptureContext(initializer.node, nested);
      if (captureContext !== undefined) {
        const captured = projectValue(
          evaluateExpression(initializer.node, captureContext),
          initializer.projection,
        );
        if (isPrimitive(captured)) value = captured;
      }
    }
  } finally {
    context.bindings.delete(binding.bindingId);
  }
  let projected = invalidateSemanticMutationPaths(value, binding.mutatedPaths);
  for (const escape of binding.escapedPaths) {
    // Escapes only invalidate object references; other lattice values survive.
    if (projected.status !== "object" && projected.status !== "array") break;
    if (
      context.capturePoint !== undefined &&
      semanticEscapeFollowsCapture(
        binding,
        context.capturePoint,
        escape.node,
        context.state.parentsByNode,
      )
    )
      continue;
    projected = invalidateSemanticEscapedPath(projected, escape.path);
  }
  // Point-local memoization also bounds failed speculative captures. Only a
  // primitive result is allowed back into ordinary value evaluation.
  if (
    context.capturePoint !== undefined ||
    projected.status === "literal" ||
    projected.status === "union" ||
    (isSemanticResourceLimit(projected) &&
      (projected.resourceLimit === "primitive-bytes" ||
        projected.resourceLimit === "primitive-candidates"))
  )
    context.primitiveBindingValues.set(binding.bindingId, projected);
  return projected;
};

const evaluateExpression = (
  node: t.Node,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  if (context.expressionDepth > SEMANTIC_EXPRESSION_DEPTH_LIMIT)
    return semanticResourceLimitUnknown("expression-depth");
  const unwrapped = unwrapJavaScriptExpression(node);
  if (unwrapped.depth > 0) {
    if (
      context.expressionDepth + unwrapped.depth >
      SEMANTIC_EXPRESSION_DEPTH_LIMIT
    )
      return semanticResourceLimitUnknown("expression-depth");
    return evaluateExpression(unwrapped.node, {
      ...context,
      expressionDepth: context.expressionDepth + unwrapped.depth,
    });
  }
  const literal = readExactJavaScriptLiteral(node);
  if (literal.found)
    return typeof literal.value === "number"
      ? primitiveSet([literal.value])
      : { status: "literal", value: literal.value };
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(context.state, node, node.name);
    return binding === undefined
      ? { status: "unknown", reason: `Unbound identifier ${node.name}.` }
      : evaluateBinding(binding, nestedContext(context));
  }
  if (t.isTemplateLiteral(node)) return evaluateTemplate(node, context);
  if (t.isConditionalExpression(node))
    return mergeValues([
      evaluateExpression(node.consequent, nestedContext(context)),
      evaluateExpression(node.alternate, nestedContext(context)),
    ]);
  if (t.isLogicalExpression(node))
    return mergeValues([
      evaluateExpression(node.left, nestedContext(context)),
      evaluateExpression(node.right, nestedContext(context)),
    ]);
  if (t.isObjectExpression(node)) return evaluateObject(node, context);
  if (t.isArrayExpression(node)) return evaluateArray(node, context);
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    return evaluateMember(node, context);
  if (
    t.isUnaryExpression(node) ||
    t.isCallExpression(node) ||
    (t.isBinaryExpression(node) &&
      isFoldableSemanticBinaryOperator(node.operator))
  ) {
    const operands = evaluateOperands(node, context);
    return isOperands(operands) ? semanticOperandValue(operands) : operands;
  }
  return { status: "unknown", reason: `Unsupported ${node.type} value.` };
};

type OperandFailure = Extract<
  JavaScriptSemanticValue,
  { readonly status: "unknown" | "ambiguous" | "cycle" }
>;

type OperandResult = readonly JavaScriptSemanticOperand[] | OperandFailure;

const isOperands = (
  result: OperandResult,
): result is readonly JavaScriptSemanticOperand[] => Array.isArray(result);

const operandFailure = (
  value: JavaScriptSemanticValue,
  reason: string,
): OperandFailure =>
  value.status === "unknown" ||
  value.status === "ambiguous" ||
  value.status === "cycle"
    ? value
    : { status: "unknown", reason };

/** Exact primitive candidates, including values JSON evidence cannot carry. */
const evaluateOperands = (
  node: t.Node,
  context: EvaluationContext,
): OperandResult => {
  if (context.expressionDepth > SEMANTIC_EXPRESSION_DEPTH_LIMIT)
    return semanticResourceLimitUnknown("expression-depth");
  const unwrapped = unwrapJavaScriptExpression(node);
  if (unwrapped.depth > 0) {
    if (
      context.expressionDepth + unwrapped.depth >
      SEMANTIC_EXPRESSION_DEPTH_LIMIT
    )
      return semanticResourceLimitUnknown("expression-depth");
    return evaluateOperands(unwrapped.node, {
      ...context,
      expressionDepth: context.expressionDepth + unwrapped.depth,
    });
  }
  if (
    t.isBinaryExpression(node) &&
    isFoldableSemanticBinaryOperator(node.operator)
  )
    return evaluateBinaryOperands(node, context);
  if (t.isUnaryExpression(node)) return evaluateUnaryOperands(node, context);
  if (t.isCallExpression(node)) return evaluateCallOperands(node, context);
  if (t.isIdentifier(node) && GLOBAL_CONSTANTS.has(node.name)) {
    if (isUnshadowedGlobal(node, context.state, node.name))
      return [globalConstant(node.name)];
  }
  const value = evaluateExpression(node, context);
  return (
    primitiveCandidates(value) ??
    operandFailure(value, "Operand is not a bounded primitive.")
  );
};

const GLOBAL_CONSTANTS = new Set(["undefined", "NaN", "Infinity"]);

const globalConstant = (name: string): JavaScriptSemanticOperand =>
  name === "NaN" ? Number.NaN : name === "Infinity" ? Infinity : undefined;

const evaluateBinaryOperands = (
  node: t.BinaryExpression,
  context: EvaluationContext,
): OperandResult => {
  // Minified concatenations nest thousands deep on the left; walk iteratively.
  const pending: {
    readonly node: t.BinaryExpression;
    left: readonly JavaScriptSemanticOperand[] | undefined;
  }[] = [];
  let current: t.Node = node;
  for (;;) {
    if (
      t.isBinaryExpression(current) &&
      isFoldableSemanticBinaryOperator(current.operator)
    ) {
      pending.push({ node: current, left: undefined });
      current = current.left;
      continue;
    }
    let result = evaluateOperands(current, nestedContext(context));
    for (;;) {
      if (!isOperands(result)) return result;
      const parent = pending.at(-1);
      if (parent === undefined) return result;
      if (parent.left === undefined) {
        parent.left = result;
        current = parent.node.right;
        break;
      }
      result = combineOperands(parent.node.operator, parent.left, result);
      pending.pop();
    }
  }
};

const combineOperands = (
  operator: string,
  left: readonly JavaScriptSemanticOperand[],
  right: readonly JavaScriptSemanticOperand[],
): OperandResult => {
  if (left.length > SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT / right.length)
    return semanticResourceLimitUnknown("primitive-candidates");
  if (
    operator === "+" &&
    exceedsSemanticPrimitiveAdditionByteBudget(left, right)
  )
    return semanticResourceLimitUnknown("primitive-bytes");
  return uniqueOperands(
    left.flatMap((leftValue) =>
      right.map((rightValue) =>
        applySemanticBinaryOperator(operator, leftValue, rightValue),
      ),
    ),
  );
};

const evaluateUnaryOperands = (
  node: t.UnaryExpression,
  context: EvaluationContext,
): OperandResult => {
  const argument = evaluateOperands(node.argument, nestedContext(context));
  if (!isOperands(argument)) return argument;
  const values: JavaScriptSemanticOperand[] = [];
  for (const value of argument) {
    const applied = applySemanticUnaryOperator(node.operator, value);
    if (applied === undefined)
      return {
        status: "unknown",
        reason: `Unsupported unary ${node.operator}.`,
      };
    values.push(applied.value);
  }
  return uniqueOperands(values);
};

/** Fold `String.fromCharCode` and `Array.prototype.join` over exact values. */
const evaluateCallOperands = (
  node: t.CallExpression,
  context: EvaluationContext,
): OperandResult => {
  const unsupported: OperandResult = {
    status: "unknown",
    reason: "Unsupported CallExpression value.",
  };
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    !t.isMemberExpression(callee) ||
    node.arguments.some((argument) => !t.isExpression(argument))
  )
    return unsupported;
  const method = semanticStaticPropertyKey(callee.property, callee.computed);
  const receiver = unwrapJavaScriptExpression(callee.object).node;
  if (
    method === "fromCharCode" &&
    isUnshadowedGlobal(receiver, context.state, "String")
  )
    return evaluateCharacterCodes(node.arguments, context);
  if (method === "join" && node.arguments.length <= 1)
    return evaluateJoin(receiver, node.arguments[0], context);
  return unsupported;
};

const evaluateCharacterCodes = (
  codes: t.CallExpression["arguments"],
  context: EvaluationContext,
): OperandResult => {
  let candidates = [""];
  for (const code of codes) {
    const values = evaluateOperands(code, nestedContext(context));
    if (!isOperands(values)) return values;
    if (candidates.length > SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT / values.length)
      return semanticResourceLimitUnknown("primitive-candidates");
    const suffixes = values.map((value) => String.fromCharCode(Number(value)));
    candidates = candidates.flatMap((prefix) =>
      suffixes.map((suffix) => `${prefix}${suffix}`),
    );
  }
  return uniqueOperands(candidates);
};

/** Element texts of an exact array; literal elements may be `undefined`. */
const joinItems = (
  receiver: t.Node,
  context: EvaluationContext,
): (readonly string[])[] | OperandFailure => {
  const items: (readonly string[])[] = [];
  if (t.isArrayExpression(receiver)) {
    for (const element of receiver.elements) {
      if (element === null) {
        items.push([""]);
        continue;
      }
      if (t.isSpreadElement(element))
        return { status: "unknown", reason: "Join receiver has a spread." };
      const values = evaluateOperands(element, nestedContext(context));
      if (!isOperands(values)) return values;
      items.push(values.map(semanticJoinText));
    }
    return items;
  }
  const array = evaluateExpression(receiver, nestedContext(context));
  if (array.status !== "array" || array.unknownItems)
    return operandFailure(array, "Join receiver is not an exact array.");
  for (const item of array.items) {
    if (item.presence === "absent") {
      items.push([""]);
      continue;
    }
    const values =
      item.presence === "present" ? primitiveCandidates(item.value) : null;
    if (values === null)
      return operandFailure(
        item.value,
        "Join item is not a bounded primitive.",
      );
    items.push(values.map(semanticJoinText));
  }
  return items;
};

const evaluateJoin = (
  receiver: t.Node,
  separatorNode: t.CallExpression["arguments"][number] | undefined,
  context: EvaluationContext,
): OperandResult => {
  const items = joinItems(receiver, context);
  if (!Array.isArray(items)) return items;
  const separators =
    separatorNode === undefined
      ? [","]
      : evaluateOperands(separatorNode, nestedContext(context));
  if (!isOperands(separators)) return separators;
  const joined: string[] = [];
  for (const separator of separators) {
    const text = separator === undefined ? "," : String(separator);
    let candidates = [""];
    for (const [index, values] of items.entries()) {
      const suffixes =
        index === 0 ? values : values.map((value) => `${text}${value}`);
      if (
        candidates.length * joined.length >
          SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT ||
        candidates.length > SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT / suffixes.length
      )
        return semanticResourceLimitUnknown("primitive-candidates");
      if (exceedsSemanticTemplateByteBudget(candidates, suffixes))
        return semanticResourceLimitUnknown("primitive-bytes");
      candidates = candidates.flatMap((prefix) =>
        suffixes.map((suffix) => `${prefix}${suffix}`),
      );
    }
    joined.push(...candidates);
  }
  return uniqueOperands(joined);
};

const uniqueOperands = (
  values: readonly JavaScriptSemanticOperand[],
): readonly JavaScriptSemanticOperand[] => {
  const unique: JavaScriptSemanticOperand[] = [];
  for (const value of values)
    if (!unique.some((existing) => Object.is(existing, value)))
      unique.push(value);
  return unique;
};

const evaluateTemplate = (
  node: t.TemplateLiteral,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  let candidates = [""];
  for (let index = 0; index < node.quasis.length; index += 1) {
    const quasi = node.quasis[index];
    const text = quasi?.value.cooked;
    if (text === undefined || text === null)
      return {
        status: "unknown",
        reason: "Template text has no cooked representation.",
      };
    if (exceedsSemanticTemplateByteBudget(candidates, [text]))
      return semanticResourceLimitUnknown("primitive-bytes");
    candidates = candidates.map((prefix) => `${prefix}${text}`);
    const expression = node.expressions[index];
    if (expression === undefined) continue;
    const values = evaluateOperands(expression, nestedContext(context));
    if (!isOperands(values)) {
      if (isSemanticResourceLimit(values)) return values;
      return {
        status: "unknown",
        reason: "Template expression is not a bounded primitive.",
      };
    }
    if (candidates.length > SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT / values.length)
      return semanticResourceLimitUnknown("primitive-candidates");
    const suffixes = values.map((value) => String(value));
    if (exceedsSemanticTemplateByteBudget(candidates, suffixes))
      return semanticResourceLimitUnknown("primitive-bytes");
    candidates = candidates.flatMap((prefix) =>
      suffixes.map((suffix) => `${prefix}${suffix}`),
    );
  }
  return primitiveSet(candidates);
};

const evaluateObject = (
  node: t.ObjectExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const propertiesByName = new Map<string, JavaScriptSemanticProperty>();
  let unknownProperties = false;
  let omittedProperties: number | null = 0;
  const invalidateEarlierProperties = (): void => {
    for (const [name] of propertiesByName)
      propertiesByName.set(name, {
        name,
        presence: "present",
        value: {
          status: "unknown",
          reason: "A later property may overwrite this value.",
        },
      });
  };
  for (const property of node.properties) {
    if (t.isSpreadElement(property)) {
      unknownProperties = true;
      omittedProperties = null;
      invalidateEarlierProperties();
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      unknownProperties = true;
      if (omittedProperties !== null) omittedProperties += 1;
      invalidateEarlierProperties();
      continue;
    }
    // This spelling changes the prototype instead of defining an own slot.
    if (
      t.isObjectProperty(property) &&
      !property.computed &&
      !property.shorthand &&
      name === "__proto__"
    ) {
      unknownProperties = true;
      if (omittedProperties !== null) omittedProperties += 1;
      continue;
    }
    propertiesByName.set(name, {
      name,
      presence: "present",
      value: t.isObjectProperty(property)
        ? evaluateCapturedExpression(property.value, nestedContext(context))
        : {
            status: "unknown",
            reason: "Object method or accessor value is not a primitive.",
          },
    });
  }
  const properties = [...propertiesByName.values()].sort((left, right) =>
    compareUnicodeCodePoints(left.name, right.name),
  );
  return unknownProperties
    ? {
        status: "object",
        properties,
        unknownProperties: true,
        omittedProperties,
      }
    : {
        status: "object",
        properties,
        unknownProperties: false,
        omittedProperties: 0,
      };
};

const evaluateArray = (
  node: t.ArrayExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const items: JavaScriptSemanticProperty[] = [];
  let unknownItems = false;
  let omittedItems: number | null = 0;
  for (const element of node.elements) {
    if (t.isSpreadElement(element)) {
      unknownItems = true;
      omittedItems = null;
      // Subsequent elements have no fixed index after an unknown-length spread.
      break;
    }
    if (element === null) {
      items.push({
        name: String(items.length),
        presence: "absent",
        value: { status: "unknown", reason: "Array hole has no own value." },
      });
      continue;
    }
    items.push({
      name: String(items.length),
      presence: "present",
      value: evaluateCapturedExpression(element, nestedContext(context)),
    });
  }
  return unknownItems
    ? { status: "array", items, unknownItems: true, omittedItems }
    : {
        status: "array",
        items,
        unknownItems: false,
        omittedItems: 0,
      };
};

const evaluateMember = (
  node: t.MemberExpression | t.OptionalMemberExpression,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  const keys: string[] = [];
  let current: t.Node = node;
  let value: JavaScriptSemanticValue | undefined;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    if (!t.isNode(current.object)) {
      value = { status: "unknown", reason: "Unsupported member base." };
      break;
    }
    const key = semanticStaticPropertyKey(current.property, current.computed);
    if (key === null) {
      value = { status: "unknown", reason: "Dynamic member key." };
      break;
    }
    keys.push(key);
    current = current.object;
  }
  value ??= evaluateExpression(current, nestedContext(context));
  for (const key of keys.reverse()) value = projectValue(value, [key]);
  return value;
};

const projectValue = (
  value: JavaScriptSemanticValue,
  projection: readonly (string | number | null)[],
): JavaScriptSemanticValue => {
  if (projection.includes(null))
    return { status: "unknown", reason: "Cannot project a dynamic property." };
  const path = projection.map((key) => String(key));
  const slot = semanticSlotAtPath(value, path);
  return slot.presence === "present"
    ? slot.value
    : {
        status: "unknown",
        reason: `Own property ${path.join("/")} is ${slot.presence}.`,
      };
};

const provenanceForBinding = (
  binding: JavaScriptSemanticBindingState,
  context: EvaluationContext,
): JavaScriptBindingProvenance => {
  const provenance = provenanceForBindingValue(binding, context);
  const assigned = binding.definitions.some(
    ({ kind }) => kind === "assignment",
  );
  const conditionallyInitialized = binding.initializers.some(({ node }) =>
    context.state.conditionalInitializers.has(node),
  );
  if (
    provenance.status !== "module" ||
    (!assigned && !conditionallyInitialized)
  )
    return provenance;
  return semanticAmbiguousProvenance(
    provenance.origins,
    assigned
      ? `Binding ${binding.name} may be reassigned.`
      : `Binding ${binding.name} is conditionally initialized.`,
  );
};

const provenanceForBindingValue = (
  binding: JavaScriptSemanticBindingState,
  context: EvaluationContext,
): JavaScriptBindingProvenance => {
  if (context.bindings.has(binding.bindingId))
    return semanticUnresolvedProvenance(
      "cycle",
      `Alias cycle at ${binding.name}.`,
    );
  if (binding.directOrigins.length > 0)
    return semanticOriginsProvenance(binding.directOrigins);
  if (binding.initializers.length === 0) return semanticLocalProvenance();
  if (binding.initializers.length > 1)
    return semanticAmbiguousProvenance(
      [],
      `Binding ${binding.name} has multiple possible assignments.`,
    );
  const initializer = binding.initializers[0];
  if (initializer === undefined)
    return semanticUnresolvedProvenance(
      "unknown",
      "Missing binding initializer.",
    );
  if (initializer.projection.includes(null))
    return semanticUnresolvedProvenance(
      "unknown",
      "Dynamic provenance projection.",
    );
  context.bindings.add(binding.bindingId);
  let resolved: JavaScriptBindingProvenance;
  try {
    resolved = provenanceForExpression(
      initializer.node,
      nestedContext(context),
    );
  } finally {
    context.bindings.delete(binding.bindingId);
  }
  if (resolved.status !== "module" || initializer.projection.length === 0)
    return resolved;
  return semanticOriginsProvenance(
    resolved.origins.map((origin) => ({
      ...origin,
      importedPath: [
        ...origin.importedPath,
        ...initializer.projection.map((segment) => String(segment)),
      ],
    })),
  );
};

const provenanceForExpression = (
  node: t.Node,
  context: EvaluationContext,
): JavaScriptBindingProvenance => {
  if (context.expressionDepth > SEMANTIC_EXPRESSION_DEPTH_LIMIT)
    return semanticUnresolvedProvenance(
      "unknown",
      semanticResourceLimitReason("expression-depth"),
    );
  const unwrapped = unwrapJavaScriptExpression(node);
  if (unwrapped.depth > 0) {
    if (
      context.expressionDepth + unwrapped.depth >
      SEMANTIC_EXPRESSION_DEPTH_LIMIT
    )
      return semanticUnresolvedProvenance(
        "unknown",
        semanticResourceLimitReason("expression-depth"),
      );
    return provenanceForExpression(unwrapped.node, {
      ...context,
      expressionDepth: context.expressionDepth + unwrapped.depth,
    });
  }
  const required = semanticRequireOrigin(node, context.state);
  if (required !== undefined)
    return semanticOriginsProvenance([required.origin]);
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(context.state, node, node.name);
    return binding === undefined
      ? semanticUnresolvedProvenance(
          "unknown",
          `Unbound identifier ${node.name}.`,
        )
      : provenanceForBinding(binding, nestedContext(context));
  }
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    const members: string[] = [];
    let current: t.Node = node;
    while (
      t.isMemberExpression(current) ||
      t.isOptionalMemberExpression(current)
    ) {
      if (!t.isNode(current.object))
        return semanticUnresolvedProvenance(
          "unknown",
          "Unsupported member base.",
        );
      const member = semanticStaticPropertyKey(
        current.property,
        current.computed,
      );
      if (member === null)
        return semanticUnresolvedProvenance(
          "unknown",
          "Dynamic provenance member.",
        );
      members.push(member);
      current = current.object;
    }
    const base = provenanceForExpression(current, nestedContext(context));
    const path = members.reverse();
    return base.status !== "module"
      ? base
      : semanticOriginsProvenance(
          base.origins.map((origin) => ({
            ...origin,
            importedPath: [...origin.importedPath, ...path],
          })),
        );
  }
  if (t.isConditionalExpression(node) || t.isLogicalExpression(node)) {
    const left = t.isConditionalExpression(node) ? node.consequent : node.left;
    const right = t.isConditionalExpression(node) ? node.alternate : node.right;
    const candidates = [
      provenanceForExpression(left, nestedContext(context)),
      provenanceForExpression(right, nestedContext(context)),
    ];
    const origins = uniqueSemanticOrigins(
      candidates.flatMap((candidate) => candidate.origins),
    );
    const allModuleOrigins = candidates.every(
      ({ status }) => status === "module",
    );
    if (allModuleOrigins && origins.length === 1)
      return semanticOriginsProvenance(origins);
    return origins.length > 0
      ? semanticAmbiguousProvenance(
          origins,
          allModuleOrigins
            ? "Multiple module origins."
            : "Conditional provenance includes a non-module alternative.",
        )
      : semanticUnresolvedProvenance(
          "unknown",
          "Conditional provenance is unresolved.",
        );
  }
  return semanticLocalProvenance();
};

const mergeValues = (
  values: readonly JavaScriptSemanticValue[],
): JavaScriptSemanticValue => {
  const resourceLimit = values.find(isSemanticResourceLimit);
  if (resourceLimit !== undefined) return resourceLimit;
  const primitives = values.flatMap(
    (value) => primitiveCandidates(value) ?? [],
  );
  return values.every(
    (value) => value.status === "union" || value.status === "literal",
  )
    ? primitiveSet(primitives)
    : { status: "ambiguous", reason: "Branches have incompatible values." };
};

const nestedContext = (context: EvaluationContext): EvaluationContext => ({
  state: context.state,
  primitiveBindingValues: context.primitiveBindingValues,
  ...(context.capturePoint === undefined
    ? {}
    : { capturePoint: context.capturePoint }),
  expressionDepth: context.expressionDepth + 1,
  bindings: context.bindings,
});

const isPrimitive = (value: JavaScriptSemanticValue): boolean =>
  value.status === "literal" || value.status === "union";

const primitiveCaptureContext = (
  node: t.Node,
  context: EvaluationContext,
): EvaluationContext | undefined => {
  if (t.isObjectExpression(node) || t.isArrayExpression(node)) return undefined;
  return captureContextAt(node, context);
};

const captureContextAt = (
  node: t.Node,
  context: EvaluationContext,
): EvaluationContext | undefined => {
  if (
    context.capturePoint !== undefined ||
    semanticCapturePosition(node, context.state.parentsByNode) === null
  )
    return undefined;
  let captures = capturedBindingValuesByState.get(context.state);
  if (captures === undefined) {
    captures = new WeakMap();
    capturedBindingValuesByState.set(context.state, captures);
  }
  let values = captures.get(node);
  if (values === undefined) {
    values = new Map();
    captures.set(node, values);
  }
  return { ...context, capturePoint: node, primitiveBindingValues: values };
};

const evaluateCapturedExpression = (
  node: t.Node,
  context: EvaluationContext,
): JavaScriptSemanticValue => {
  // A literal field captures its primitive at construction, even when its
  // containing object is subsequently read at another capture point.
  let values = primitiveExpressionValuesByState.get(context.state);
  const cached = values?.get(node);
  if (cached !== undefined) return cached;
  let value = evaluateExpression(node, context);
  if (!isPrimitive(value)) {
    const captureContext = primitiveCaptureContext(node, context);
    if (captureContext !== undefined) {
      const captured = evaluateExpression(node, captureContext);
      if (isPrimitive(captured)) value = captured;
    }
  }
  // Never publish values evaluated at somebody else's capture point. Like
  // binding caches, these entries are discarded whenever effects change.
  if (context.capturePoint === undefined && isPrimitive(value)) {
    if (values === undefined) {
      values = new WeakMap();
      primitiveExpressionValuesByState.set(context.state, values);
    }
    values.set(node, value);
  }
  return value;
};

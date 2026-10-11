import type {
  JavaScriptSemanticPrimitive,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";
import { semanticPrimitiveSet } from "./javascriptSemanticPrimitives.js";

/**
 * One exact primitive operand. Operands may hold `undefined`, `NaN`, the
 * infinities, and negative zero while an expression is folded; only the final
 * value must fit the JSON primitive lattice.
 */
export type JavaScriptSemanticOperand = JavaScriptSemanticPrimitive | undefined;

// Operands are primitives, so the casts select JavaScript's own coercions and
// the host operators compute exact results without invoking application code.
type BinaryOperator = (
  left: number,
  right: number,
) => JavaScriptSemanticOperand;

const BINARY_OPERATORS: ReadonlyMap<string, BinaryOperator> = new Map<
  string,
  BinaryOperator
>([
  ["+", (left, right) => left + right],
  ["-", (left, right) => left - right],
  ["*", (left, right) => left * right],
  ["/", (left, right) => left / right],
  ["%", (left, right) => left % right],
  ["**", (left, right) => left ** right],
  ["==", (left, right) => left == right],
  ["!=", (left, right) => left != right],
  ["===", (left, right) => left === right],
  ["!==", (left, right) => left !== right],
  ["<", (left, right) => left < right],
  ["<=", (left, right) => left <= right],
  [">", (left, right) => left > right],
  [">=", (left, right) => left >= right],
  ["<<", (left, right) => left << right],
  [">>", (left, right) => left >> right],
  [">>>", (left, right) => left >>> right],
  ["&", (left, right) => left & right],
  ["|", (left, right) => left | right],
  ["^", (left, right) => left ^ right],
]);

/** Binary operators whose primitive operands cannot invoke application code. */
export const isFoldableSemanticBinaryOperator = (operator: string): boolean =>
  BINARY_OPERATORS.has(operator);

/** Apply one foldable binary operator to primitive operands. */
export const applySemanticBinaryOperator = (
  operator: string,
  left: JavaScriptSemanticOperand,
  right: JavaScriptSemanticOperand,
): JavaScriptSemanticOperand => {
  const apply = BINARY_OPERATORS.get(operator);
  if (apply === undefined)
    throw new TypeError(`Unsupported folded operator ${operator}`);
  return apply(left as number, right as number);
};

/** Apply one side-effect-free unary operator, or report it as unsupported. */
export const applySemanticUnaryOperator = (
  operator: string,
  argument: JavaScriptSemanticOperand,
): { readonly value: JavaScriptSemanticOperand } | undefined => {
  switch (operator) {
    case "!":
      return { value: !argument };
    case "-":
      return { value: -(argument as number) };
    case "+":
      return { value: +(argument as number) };
    case "~":
      return { value: ~(argument as number) };
    case "typeof":
      return { value: typeof argument };
    case "void":
      return { value: undefined };
    default:
      return undefined;
  }
};

/** Convert folded operands to a JSON lattice value without losing exactness. */
export const semanticOperandValue = (
  operands: readonly JavaScriptSemanticOperand[],
): JavaScriptSemanticValue =>
  operands.includes(undefined)
    ? {
        status: "unknown",
        reason: "undefined is outside the JSON primitive lattice.",
      }
    : semanticPrimitiveSet(operands as readonly JavaScriptSemanticPrimitive[]);

/** The text `Array.prototype.join` produces for one primitive element. */
export const semanticJoinText = (value: JavaScriptSemanticOperand): string =>
  value === null || value === undefined ? "" : String(value);

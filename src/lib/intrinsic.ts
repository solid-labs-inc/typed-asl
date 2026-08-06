import { type Ref, REF_PATH } from './types.js';

/**
 * Symbol used as a key to identify intrinsic function expressions.
 * Distinguished from Ref's REF_PATH symbol.
 */
export const INTRINSIC_EXPR: unique symbol = Symbol('intrinsicExpr');

/**
 * An intrinsic function expression (e.g. `States.Format(...)`, `States.JsonToString(...)`).
 *
 * Serialized as a `"key.$"` value in ASL JSON, similar to Ref values.
 * Carries a phantom type `T` representing the expression's result type.
 */
export type IntrinsicExpr<T = string> = {
  readonly [INTRINSIC_EXPR]: string;
  /** Phantom type brand — never exists at runtime */
  readonly __intrinsicType: T;
};

/**
 * Type guard to check whether a value is an IntrinsicExpr.
 */
export function isIntrinsic(value: unknown): value is IntrinsicExpr {
  return value != null && typeof value === 'object' && INTRINSIC_EXPR in value;
}

/**
 * Extract the expression string from an IntrinsicExpr.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getExpression(expr: IntrinsicExpr<any>): string {
  return expr[INTRINSIC_EXPR];
}

function createIntrinsic<T>(expression: string): IntrinsicExpr<T> {
  return {
    [INTRINSIC_EXPR]: expression,
    __intrinsicType: undefined as unknown as T,
  };
}

function argToString(arg: Ref<unknown> | IntrinsicExpr): string {
  if (INTRINSIC_EXPR in arg) {
    return (arg as IntrinsicExpr)[INTRINSIC_EXPR];
  }
  // It's a Ref — convert path segments to JSONPath
  const segments = (arg as Ref<unknown>)[REF_PATH];
  let result = '';
  for (const seg of segments) {
    if (seg === '$' || seg === '$$') {
      result = seg;
    } else if (seg.startsWith('[')) {
      result += seg;
    } else {
      result += `.${seg}`;
    }
  }
  return result;
}

/**
 * Step Functions `States.Format()` intrinsic function.
 *
 * Produces a string by interpolating `{}` placeholders in the template
 * with the provided arguments (refs or other intrinsics).
 *
 * @example
 * ```ts
 * statesFormat('scene_{}/frame', item.value.id)
 * // → "States.Format('scene_{}/frame', $$.Map.Item.Value.id)"
 * ```
 */
export function statesFormat(
  template: string,
  ...args: (Ref<unknown> | IntrinsicExpr)[]
): IntrinsicExpr<string> {
  const argStrings = args.map(argToString);
  const allArgs = [`'${template}'`, ...argStrings].join(', ');
  return createIntrinsic<string>(`States.Format(${allArgs})`);
}

/**
 * Step Functions `States.JsonToString()` intrinsic function.
 *
 * Converts a JSON value to its string representation.
 *
 * @example
 * ```ts
 * statesJsonToString(ctx.extractScenes)
 * // → "States.JsonToString($.extractScenes)"
 * ```
 */
export function statesJsonToString(ref: Ref<unknown>): IntrinsicExpr<string> {
  return createIntrinsic<string>(`States.JsonToString(${argToString(ref)})`);
}

/**
 * Step Functions `States.MathAdd()` intrinsic function.
 *
 * Adds an integer operand to a numeric value referenced by a JSONPath.
 *
 * @example
 * ```ts
 * statesMathAdd(ctx.scene.start_frame, 1)
 * // → "States.MathAdd($.scene.start_frame, 1)"
 * ```
 */
export function statesMathAdd(
  ref: Ref<unknown>,
  operand: number,
): IntrinsicExpr<number> {
  return createIntrinsic<number>(
    `States.MathAdd(${argToString(ref)}, ${operand})`,
  );
}

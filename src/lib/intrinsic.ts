import { isRef } from './proxy.js';
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

function argToString(arg: Ref<unknown> | IntrinsicExpr<unknown>): string {
  if (INTRINSIC_EXPR in arg) {
    return (arg as IntrinsicExpr<unknown>)[INTRINSIC_EXPR];
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
 * Escape single quotes in an intrinsic function's string argument, since the
 * template is embedded in single quotes. `{}` is left untouched (it's the
 * placeholder syntax), and backslashes pass through verbatim so user-written
 * `\\{` literal-brace escapes keep working.
 */
function escapeTemplate(template: string): string {
  return template.replace(/'/g, "\\'");
}

/**
 * Step Functions `States.Format()` intrinsic function.
 *
 * Produces a string by interpolating `{}` placeholders in the template
 * with the provided arguments (refs or other intrinsics).
 *
 * Single quotes in the template are escaped automatically. To include a
 * literal `{` or `}`, escape it yourself as `\\{` / `\\}` per the ASL spec.
 *
 * @example
 * ```ts
 * statesFormat('scene_{}/frame', item.value.id)
 * // → "States.Format('scene_{}/frame', $$.Map.Item.Value.id)"
 * ```
 */
export function statesFormat(
  template: string,
  ...args: (Ref<unknown> | IntrinsicExpr<unknown>)[]
): IntrinsicExpr<string> {
  const argStrings = args.map(argToString);
  const allArgs = [`'${escapeTemplate(template)}'`, ...argStrings].join(', ');
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
export function statesJsonToString(
  ref: Ref<unknown> | IntrinsicExpr<unknown>,
): IntrinsicExpr<string> {
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
  ref: Ref<number> | IntrinsicExpr<number>,
  operand: number,
): IntrinsicExpr<number> {
  return createIntrinsic<number>(
    `States.MathAdd(${argToString(ref)}, ${operand})`,
  );
}

/**
 * Serialize a literal value as an intrinsic function argument.
 * Strings are single-quoted (with quotes escaped); numbers, booleans and
 * null are emitted bare.
 */
function literalToString(value: string | number | boolean | null): string {
  if (typeof value === 'string') return `'${escapeTemplate(value)}'`;
  return String(value);
}

/**
 * Step Functions `States.Array()` intrinsic function.
 *
 * Builds an array from refs, intrinsics, and literal values. This is the
 * way to put JSONPath values into an array — a bare ref as a plain array
 * element would serialize to a literal string, since ASL only substitutes
 * paths in object keys ending in `.$`.
 *
 * @example
 * ```ts
 * statesArray(ctx.a, 'literal', ctx.b)
 * // → "States.Array($.a, 'literal', $.b)"
 * ```
 */
export function statesArray<T>(
  ...items: (Ref<T> | IntrinsicExpr<T> | T)[]
): IntrinsicExpr<T[]> {
  const parts = items.map((item) => {
    if (isRef(item) || isIntrinsic(item)) {
      return argToString(item);
    }
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      return literalToString(item as string | number | boolean | null);
    }
    throw new Error(
      'statesArray() literal arguments must be strings, numbers, booleans or null — ' +
        'objects cannot appear as intrinsic function arguments',
    );
  });
  return createIntrinsic<T[]>(`States.Array(${parts.join(', ')})`);
}

/**
 * Step Functions `States.ArrayLength()` intrinsic function.
 *
 * @example
 * ```ts
 * statesArrayLength(ctx.scenes)
 * // → "States.ArrayLength($.scenes)"
 * ```
 */
export function statesArrayLength(
  ref: Ref<readonly unknown[]> | IntrinsicExpr<unknown[]>,
): IntrinsicExpr<number> {
  return createIntrinsic<number>(`States.ArrayLength(${argToString(ref)})`);
}

/**
 * Step Functions `States.StringToJson()` intrinsic function.
 *
 * Parses a JSON string into a value. Pass a type parameter to describe
 * the parsed shape.
 *
 * @example
 * ```ts
 * statesStringToJson<{ id: string }>(ctx.rawJson)
 * // → "States.StringToJson($.rawJson)"
 * ```
 */
export function statesStringToJson<T = unknown>(
  ref: Ref<string> | IntrinsicExpr<string>,
): IntrinsicExpr<T> {
  return createIntrinsic<T>(`States.StringToJson(${argToString(ref)})`);
}

/**
 * Step Functions `States.UUID()` intrinsic function.
 *
 * Generates a v4 UUID at execution time.
 */
export function statesUuid(): IntrinsicExpr<string> {
  return createIntrinsic<string>('States.UUID()');
}

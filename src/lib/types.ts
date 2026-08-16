import type { z } from 'zod';
import type { IntrinsicExpr } from './intrinsic.js';

/**
 * Symbol used as a key to store the JSONPath segments on a Ref proxy.
 * Using a symbol prevents collisions with real property names.
 */
export const REF_PATH: unique symbol = Symbol('refPath');

/**
 * A branded reference that carries both:
 *   - A phantom type `T` (compile-time only) representing the referenced value's type
 *   - A path (runtime) representing the JSONPath segments to reach it
 *
 * At runtime, a Ref is a Proxy object whose [REF_PATH] property returns
 * the accumulated path segments.
 */
export type Ref<T> = {
  readonly [REF_PATH]: string[];
  /** Phantom type brand — never exists at runtime */
  readonly __refType: T;
};

/**
 * Proxied<T> wraps every property of T so that accessing it returns
 * a Proxied<PropertyType> with the path recorded.
 *
 * For objects: each named property `K` is accessible and returns Proxied<T[K]>.
 * For tuples/arrays: numeric indexing returns the per-index element type.
 *
 * Every Proxied<T> is also a Ref<T>, so it can be used directly as a
 * typed reference in payload mappings.
 */
export type Proxied<T> = Ref<T> &
  (T extends readonly unknown[]
    ? number extends T['length']
      ? // Plain array: any index yields the element type
        { readonly [index: number]: Proxied<T[number]> }
      : // Tuple: only the literal indices that exist. A plain mapped
        // tuple would carry an array number-index signature, which lets
        // an out-of-range index like tup[2] through — this keyed object
        // form makes it a compile error. Array methods are deliberately
        // absent from both branches: `ctx.arr.map` would record the
        // JSONPath `$.arr.map`, which is never what anyone means.
        { readonly [K in Extract<keyof T, `${number}`>]: Proxied<T[K]> }
    : T extends object
      ? // Object: named property access
        { readonly [K in keyof T]-?: Proxied<T[K]> }
      : unknown);

/**
 * Flatten an intersection into a single object type, for display.
 *
 * Every context-widening builder method composes its result as
 * `Omit<Ctx, Name> & Record<Name, Out>` — the `Omit` is what makes a
 * repeated state name replace its earlier entry instead of intersecting
 * with it. Unwrapped, that composition is what hover shows, and it
 * nests once per chained call, so reading `ctx` off a five-task chain
 * means evaluating five layers of `Omit`/`Record` by hand.
 *
 * This mapped type resolves the intersection to its properties. The
 * result is mutually assignable with the input — only the rendering
 * changes. It is not free: resolving eagerly at each step costs ~8-13%
 * more instantiations on a 5-15 state chain (within noise on this
 * repo's own suite), and it neither raises nor lowers the chain length
 * TypeScript can handle before TS2589.
 *
 * The trailing `& {}` is load-bearing: without it TypeScript keeps the
 * alias reference and prints `Simplify<...>` instead of the object.
 *
 * Property order follows the mapped type's iteration, so it need not
 * match declaration order.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Any Zod object schema. Uses the `shape` property which is available
 * on all ZodObject instances in both Zod 3 and Zod 4.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZodObject = z.ZodObject<any>;

/**
 * Type-safe payload mapping for a Lambda Task state.
 *
 * Given a Zod input schema, produces an object type where every field
 * requires either:
 *   - A static value matching the schema's inferred type, OR
 *   - A `Ref<T>` where T matches (i.e. a proxy reference from `createProxy`)
 *
 * This ensures at compile time that:
 *   - No required fields are missing
 *   - No extra fields are passed
 *   - Ref types match the expected field types
 *
 * @example
 * ```ts
 * const schema = z.object({
 *   step: z.literal('create-atlas'),
 *   frameStorageRefs: z.array(StorageRefSchema),
 *   outputFilename: z.string(),
 * });
 *
 * // TypedPayloadMapping<typeof schema> =
 * // {
 * //   step: 'create-atlas';
 * //   frameStorageRefs: StorageRef[] | Ref<StorageRef[]>;
 * //   outputFilename: string | Ref<string>;
 * // }
 * ```
 */
export type TypedPayloadMapping<T extends AnyZodObject> = {
  [
    K in keyof T['shape'] as undefined extends z.infer<T['shape'][K]>
      ? never
      : K
  ]:
    | z.infer<T['shape'][K]>
    | Ref<z.infer<T['shape'][K]>>
    | IntrinsicExpr<z.infer<T['shape'][K]>>;
} & {
  [
    K in keyof T['shape'] as undefined extends z.infer<T['shape'][K]>
      ? K
      : never
  ]?:
    | z.infer<T['shape'][K]>
    | Ref<z.infer<T['shape'][K]>>
    | IntrinsicExpr<z.infer<T['shape'][K]>>;
};

/**
 * The keys of an output schema whose values may be absent (`.optional()`
 * or otherwise admitting `undefined`).
 */
export type OptionalOutputKeys<O extends AnyZodObject> = {
  [K in keyof O['shape']]: undefined extends z.infer<O['shape'][K]> ? K : never;
}[keyof O['shape']];

/**
 * Compile-time gate for the `task()` overloads that auto-generate a
 * `ResultSelector`: the generated selector references every output schema
 * key, and JSONPath-mode ASL errors at runtime when a referenced key is
 * absent — so a schema with optional fields must pass an explicit
 * `resultSelector` instead. Resolves to `unknown` (no constraint) when
 * the schema has no optional fields; otherwise to an object type whose
 * property name is the error message, which is what surfaces in the
 * compiler output.
 */
export type RequireResultSelectorForOptionalOutputs<O extends AnyZodObject> = [
  OptionalOutputKeys<O>,
] extends [never]
  ? unknown
  : {
      'output schema has optional fields, which the auto-generated ResultSelector would reference unconditionally — ASL errors at runtime on absent keys, so pass an explicit resultSelector': OptionalOutputKeys<O>;
    };

/**
 * Compile-time gate for `customTask`'s `outputSchema`: the generated
 * `ResultSelector` references every schema key, so optional fields are
 * rejected — but unlike `task` there is no custom selector to reach for.
 * The fix is naming only fields the service always returns, or dropping
 * `outputSchema` for an untyped result.
 */
export type RequireNoOptionalOutputs<O extends AnyZodObject> = [
  OptionalOutputKeys<O>,
] extends [never]
  ? unknown
  : {
      'output schema has optional fields — the generated ResultSelector references every key and ASL errors at runtime on absent ones; list only fields the service always returns, or drop outputSchema for an untyped result': OptionalOutputKeys<O>;
    };

/**
 * Companion to {@link TypedPayloadMapping}: marks every key of the mapping
 * `P` that is not in the schema as `never`, so extra fields fail to
 * compile. Plain assignability can't reject extra properties (and excess
 * property checking doesn't fire against generic mapped types), so the
 * task overloads intersect the callback's return type with this — see
 * {@link ExactPayload}.
 */
export type NoExtraPayloadKeys<T extends AnyZodObject, P> = {
  [K in Exclude<keyof P, keyof T['shape']>]: never;
};

/**
 * The payload-callback return type every `task()` overload uses: the
 * inferred mapping `P` (constrained to `TypedPayloadMapping<T>`), with
 * extra keys rejected. A single alias so an overload can't accidentally
 * be written without the exact-key check.
 */
export type ExactPayload<T extends AnyZodObject, P> = P &
  NoExtraPayloadKeys<T, P>;

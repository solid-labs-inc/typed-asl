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
 * {@link ContextOf} builds the accumulated context as an intersection
 * of two mapped types — the unclaimed keys of the base, and the keys
 * the states contribute. Unwrapped, that composition is what hover
 * shows, and hover is how a reader answers "what can I reach on `ctx`?".
 *
 * This mapped type resolves the intersection to its properties. The
 * result is mutually assignable with the input — only the rendering
 * changes.
 *
 * It is applied once, inside `ContextOf`, over a flat structure. That
 * placement matters: wrapping a composition that *nests* per chained
 * call (as the pre-#14 `Omit<Ctx, Name> & Record<Name, Out>` return
 * did) bought the display but left the underlying stack, and cost ~5%
 * extra instantiations for it.
 *
 * The trailing `& {}` is load-bearing: without it TypeScript keeps the
 * alias reference and prints `Simplify<...>` instead of the object.
 *
 * Property order follows the mapped type's iteration, so it need not
 * match declaration order.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * One accumulated state's contribution to the context: the key its
 * result lands at (`$.{key}`) and the type stored there.
 *
 * The builder carries these as a flat tuple rather than folding each
 * one into the context as it goes — see {@link ContextOf}.
 */
export type StateEntry = readonly [key: string, output: unknown];

/**
 * The output recorded for `K` by the *last* entry that claims it.
 *
 * Scans from the right and stops at the first match, which is what
 * makes a later state at the same key replace an earlier one rather
 * than intersect with it. A stale `A & B` would let refs to the
 * overwritten shape keep compiling after the data is gone.
 */
type LatestEntry<
  E extends readonly StateEntry[],
  K extends string,
> = E extends readonly [
  ...infer Rest extends readonly StateEntry[],
  infer Last extends StateEntry,
]
  ? Last[0] extends K
    ? Last[1]
    : LatestEntry<Rest, K>
  : never;

/**
 * The context a chain exposes: the starting type `Base`, with every
 * accumulated entry applied over it.
 *
 * The shape here is the whole point. The obvious formulation folds each
 * state into the context as the chain grows — `Omit<Ctx, Name> &
 * Record<Name, Out>` — which makes `Ctx` at step N a mapped type
 * wrapping the mapped type from step N-1. That stack costs `2^N` to
 * resolve and hits TS2589 at 17 chained calls (#14).
 *
 * Mapping over a flat tuple instead never wraps a previous mapped type,
 * so each materialization is one pass over N entries and the whole
 * chain is quadratic: ~49k instantiations at 16 states against ~29.3M
 * for the folded form, and no ceiling at 100.
 *
 * Keys of `Base` that an entry claims are dropped, so a state may
 * shadow an input field (`.pass('key', …)` over `Base['key']`).
 *
 * `LatestEntry` scans the tuple per key, which makes one
 * materialization quadratic and the whole chain cubic — the cost that
 * remains after the exponent is gone. Two cheaper formulations were
 * measured and rejected:
 *
 * - Key-remapping the entry union (`{ [K in E[number] as K[0]]: K[1] }`)
 *   is ~24x faster by 48 states, but a union has no order: duplicate
 *   keys merge into `A & B` instead of the later one winning, which is
 *   precisely the guarantee `builder.test.ts` pins.
 * - Dropping the superseded entry at append time would let the fast
 *   form be used, but the filter runs over the previous filter's
 *   result — nesting per link, which is the original bug in tuple
 *   form. It reintroduced TS2589, at 48 states instead of 17.
 *
 * So the scan stays. In practice it is bounded by state count: 40
 * states type-check in well under a second, against a hard failure at
 * 17 before.
 */
export type ContextOf<Base, E extends readonly StateEntry[]> = Simplify<
  {
    [K in Exclude<keyof Base, E[number][0]>]: Base[K];
  } & {
    [K in E[number][0]]: LatestEntry<E, K>;
  }
>;

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

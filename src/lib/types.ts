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
  // Tuple/array: mapped tuple preserves per-index types
  (T extends readonly unknown[]
    ? { readonly [K in keyof T]: Proxied<T[K]> }
    : unknown) &
  // Object: named property access
  (T extends object ? { readonly [K in keyof T]-?: Proxied<T[K]> } : unknown);

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

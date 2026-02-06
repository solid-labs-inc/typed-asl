import { type Proxied, type Ref, REF_PATH } from './types.js';

/**
 * Creates a typed Proxy that records property access as JSONPath segments.
 *
 * Every property access on the returned proxy returns a new proxy with
 * the property name appended to the path. Numeric keys (e.g. `[0]`) are
 * recorded as array index segments.
 *
 * @example
 * ```ts
 * type Ctx = { foo: { bar: string[] } };
 * const proxy = createProxy<Ctx>();
 * const ref = proxy.foo.bar;
 * pathOf(ref); // "$.foo.bar"
 * ```
 */
export function createProxy<T>(path: string[] = ['$']): Proxied<T> {
  return new Proxy(Object.create(null), {
    get(_, prop: string | symbol): unknown {
      if (prop === REF_PATH) return path;
      if (typeof prop === 'symbol') return undefined;
      const segment = /^\d+$/.test(prop) ? `[${prop}]` : prop;
      return createProxy([...path, segment]);
    },
    has(_, prop: string | symbol): boolean {
      return prop === REF_PATH;
    },
  }) as Proxied<T>;
}

/**
 * Extracts the JSONPath string from a Ref.
 *
 * Converts the internal path segments into a dot-separated JSONPath string,
 * with array indices attached directly (no dot before brackets).
 *
 * @example
 * ```ts
 * pathOf(proxy.foo.bar)        // "$.foo.bar"
 * pathOf(proxy.items[0].name)  // "$.items[0].name"
 * ```
 */
export function pathOf(ref: Ref<unknown>): string {
  const segments = ref[REF_PATH];
  let result = '';
  for (const seg of segments) {
    if (seg === '$') {
      result = '$';
    } else if (seg.startsWith('[')) {
      result += seg;
    } else {
      result += `.${seg}`;
    }
  }
  return result;
}

/**
 * Type guard to check whether a value is a Ref (i.e. a proxy created by createProxy).
 */
export function isRef(value: unknown): value is Ref<unknown> {
  return value != null && typeof value === 'object' && REF_PATH in value;
}

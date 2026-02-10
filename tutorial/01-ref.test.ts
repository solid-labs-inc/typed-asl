/**
 * Chapter 1: Ref<T> — The Branded Phantom Type
 *
 * A `Ref<T>` is the fundamental building block. It's a type that carries two
 * pieces of information simultaneously:
 *
 *   - At compile time: a phantom type `T` representing the referenced value's type
 *   - At runtime: an array of JSONPath segments stored under a unique symbol
 *
 * Think of it as a typed pointer into the Step Functions state data.
 * When you hold a `Ref<number>`, TypeScript knows the value at that path
 * is a number, even though at runtime it's just a path like "$.width".
 */
import { describe, it, expect, expectTypeOf } from 'vitest';

import { createProxy, pathOf, isRef } from '../src/index.js';
import { REF_PATH } from '../src/lib/types.js';
import type { Ref } from '../src/index.js';

describe('Chapter 1: Ref<T> — Branded Phantom Types', () => {
  // ── The REF_PATH symbol ──────────────────────────────────────────────

  it('REF_PATH is a unique symbol that stores the JSONPath segments', () => {
    // REF_PATH is the runtime key. Using a symbol prevents collisions
    // with real property names in the state data.
    expect(typeof REF_PATH).toBe('symbol');
    expect(REF_PATH.toString()).toBe('Symbol(refPath)');
  });

  // ── What a Ref looks like at runtime ─────────────────────────────────

  it('a Ref carries path segments at runtime via REF_PATH', () => {
    // createProxy builds a Ref — we'll explore proxies fully in chapter 2.
    // For now, just observe that the result has a REF_PATH property.
    type State = { width: number };
    const ctx = createProxy<State>();

    // Accessing `.width` returns a Ref whose path segments are ['$', 'width']
    const widthRef = ctx.width;
    expect(widthRef[REF_PATH]).toEqual(['$', 'width']);

    // pathOf() joins the segments into a JSONPath string
    expect(pathOf(widthRef)).toBe('$.width');
  });

  // ── The phantom type (compile-time only) ─────────────────────────────

  it('Ref<T> carries a phantom type T that only exists at compile time', () => {
    type State = { width: number; name: string };
    const ctx = createProxy<State>();

    // ctx.width is typed as Proxied<number>, which extends Ref<number>.
    // ctx.name is typed as Proxied<string>, which extends Ref<string>.
    // The phantom type prevents mixing them up.
    expectTypeOf(ctx.width).toExtend<Ref<number>>();
    expectTypeOf(ctx.name).toExtend<Ref<string>>();

    // This is purely a compile-time distinction. At runtime, both are
    // proxy objects with path segments — there's no actual number or string.
    expect(pathOf(ctx.width)).toBe('$.width');
    expect(pathOf(ctx.name)).toBe('$.name');
  });

  // ── isRef type guard ─────────────────────────────────────────────────

  it('isRef() checks if a value is a Ref at runtime', () => {
    const ctx = createProxy<{ x: number }>();

    // Ref proxies pass the type guard
    expect(isRef(ctx.x)).toBe(true);
    expect(isRef(ctx)).toBe(true);

    // Plain values do not
    expect(isRef(42)).toBe(false);
    expect(isRef('$.x')).toBe(false);
    expect(isRef(null)).toBe(false);
    expect(isRef({ path: '$.x' })).toBe(false);
  });

  // ── Why phantom types matter ─────────────────────────────────────────

  it('phantom types prevent passing a Ref<string> where Ref<number> is expected', () => {
    // This is the key insight: the TypeScript compiler won't let you
    // use a Ref<string> in a position that requires Ref<number>.
    //
    // In a payload mapping like:
    //   { width: ctx.name }    // ERROR: Ref<string> is not assignable to Ref<number>
    //   { width: ctx.width }   // OK: Ref<number> matches
    //
    // We can verify this with expectTypeOf:
    type State = { width: number; name: string };
    const ctx = createProxy<State>();

    expectTypeOf(ctx.width).toExtend<Ref<number>>();
    expectTypeOf(ctx.name).not.toExtend<Ref<number>>();
    expectTypeOf(ctx.name).toExtend<Ref<string>>();
  });
});

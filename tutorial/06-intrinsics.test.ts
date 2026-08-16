/**
 * Chapter 6: Intrinsic Functions
 *
 * Step Functions has built-in "intrinsic functions" like `States.Format()`,
 * `States.JsonToString()`, and `States.MathAdd()`. These are expressions
 * that run inside the state machine, not in a Lambda.
 *
 * Our type-safe approach wraps these as `IntrinsicExpr<T>` — a branded type
 * that follows the same pattern as `Ref<T>`:
 *
 *   - Phantom type `T` at compile time (e.g., `IntrinsicExpr<string>`)
 *   - Expression string at runtime (e.g., `"States.Format('hello {}', $.name)"`)
 *
 * Because `IntrinsicExpr<T>` is accepted anywhere `Ref<T>` is in a payload
 * mapping, you can use intrinsics wherever you'd use a reference.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';

import {
  createProxy,
  statesArray,
  statesArrayLength,
  statesFormat,
  statesJsonToString,
  statesMathAdd,
  statesStringToJson,
  statesUuid,
  getExpression,
  isIntrinsic,
  serializeParameters,
} from '../src/index.js';
import type { IntrinsicExpr } from '../src/index.js';

describe('Chapter 6: Intrinsic Functions', () => {
  // ── States.Format ────────────────────────────────────────────────────

  it('statesFormat() produces a States.Format() expression', () => {
    type Ctx = { sceneId: string; frameIndex: number };
    const ctx = createProxy<Ctx>();

    // States.Format interpolates {} placeholders with refs
    const expr = statesFormat('scene_{}/frame_{}', ctx.sceneId, ctx.frameIndex);

    // The expression string
    expect(getExpression(expr)).toBe(
      "States.Format('scene_{}/frame_{}', $.sceneId, $.frameIndex)",
    );

    // The phantom type is string (format always returns a string)
    expectTypeOf(expr).toExtend<IntrinsicExpr<string>>();
  });

  it('statesFormat() with no args is a simple template', () => {
    const expr = statesFormat('hello world');
    expect(getExpression(expr)).toBe("States.Format('hello world')");
  });

  // ── States.JsonToString ──────────────────────────────────────────────

  it('statesJsonToString() converts a value to its JSON string', () => {
    type Ctx = { data: { scenes: unknown[] } };
    const ctx = createProxy<Ctx>();

    const expr = statesJsonToString(ctx.data);

    expect(getExpression(expr)).toBe('States.JsonToString($.data)');
    expectTypeOf(expr).toExtend<IntrinsicExpr<string>>();
  });

  // ── States.MathAdd ───────────────────────────────────────────────────

  it('statesMathAdd() adds an integer to a numeric ref', () => {
    type Ctx = { scene: { startFrame: number } };
    const ctx = createProxy<Ctx>();

    const expr = statesMathAdd(ctx.scene.startFrame, 1);

    expect(getExpression(expr)).toBe('States.MathAdd($.scene.startFrame, 1)');
    expectTypeOf(expr).toExtend<IntrinsicExpr<number>>();
  });

  // ── isIntrinsic type guard ───────────────────────────────────────────

  it('isIntrinsic() distinguishes intrinsics from refs and plain values', () => {
    const ctx = createProxy<{ x: number }>();
    const expr = statesFormat('{}', ctx.x);

    expect(isIntrinsic(expr)).toBe(true);
    expect(isIntrinsic(ctx.x)).toBe(false); // a Ref, not an intrinsic
    expect(isIntrinsic('hello')).toBe(false);
    expect(isIntrinsic(42)).toBe(false);
  });

  // ── Intrinsics compose with each other ───────────────────────────────

  it('intrinsics can be nested inside other intrinsics', () => {
    type Ctx = { data: unknown; label: string };
    const ctx = createProxy<Ctx>();

    // Nest JsonToString inside Format
    const inner = statesJsonToString(ctx.data);
    const outer = statesFormat('payload: {}', inner);

    expect(getExpression(outer)).toBe(
      "States.Format('payload: {}', States.JsonToString($.data))",
    );
  });

  // ── States.Array & friends ───────────────────────────────────────────

  it('statesArray() builds an array from refs and literals', () => {
    // This is the only way to get JSONPath values into an array — a bare
    // ref as a plain array element is rejected by serialization, since ASL
    // has no path substitution inside arrays (see chapter 5).
    type Ctx = { a: string; b: string };
    const ctx = createProxy<Ctx>();

    const expr = statesArray(ctx.a, 'literal', ctx.b);
    expect(getExpression(expr)).toBe("States.Array($.a, 'literal', $.b)");
    expectTypeOf(expr).toExtend<IntrinsicExpr<string[]>>();
  });

  it('statesArrayLength() counts array elements', () => {
    type Ctx = { scenes: { id: string }[] };
    const ctx = createProxy<Ctx>();

    const expr = statesArrayLength(ctx.scenes);
    expect(getExpression(expr)).toBe('States.ArrayLength($.scenes)');
    expectTypeOf(expr).toExtend<IntrinsicExpr<number>>();
  });

  it('statesStringToJson() parses a JSON string, typed via parameter', () => {
    type Ctx = { rawJson: string };
    const ctx = createProxy<Ctx>();

    const expr = statesStringToJson<{ id: string }>(ctx.rawJson);
    expect(getExpression(expr)).toBe('States.StringToJson($.rawJson)');
    expectTypeOf(expr).toExtend<IntrinsicExpr<{ id: string }>>();
  });

  it('statesUuid() generates a UUID at execution time', () => {
    const expr = statesUuid();
    expect(getExpression(expr)).toBe('States.UUID()');
    expectTypeOf(expr).toExtend<IntrinsicExpr<string>>();
  });

  // ── Intrinsics in serialization ──────────────────────────────────────

  it('intrinsics serialize to "key.$" just like refs', () => {
    type Ctx = { id: string; data: unknown; count: number };
    const ctx = createProxy<Ctx>();

    const result = serializeParameters({
      label: statesFormat('item_{}', ctx.id),
      payload: statesJsonToString(ctx.data),
      nextCount: statesMathAdd(ctx.count, 1),
      // Mix with a regular ref and a static value
      rawId: ctx.id,
      version: 2,
    });

    expect(result).toEqual({
      'label.$': "States.Format('item_{}', $.id)",
      'payload.$': 'States.JsonToString($.data)',
      'nextCount.$': 'States.MathAdd($.count, 1)',
      'rawId.$': '$.id',
      version: 2,
    });
  });
});

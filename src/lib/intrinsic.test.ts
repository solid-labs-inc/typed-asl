import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  getExpression,
  statesArrayContains,
  statesArrayGetItem,
  statesArrayPartition,
  statesArrayRange,
  statesArrayUnique,
  statesBase64Decode,
  statesBase64Encode,
  statesHash,
  statesJsonMerge,
  statesMathRandom,
  statesStringSplit,
  type IntrinsicExpr,
} from './intrinsic.js';
import { createProxy } from './proxy.js';

type Ctx = {
  scenes: { id: string }[];
  frames: number[];
  index: number;
  key: string;
  assetType: string;
  defaults: { width: number; quality: string };
  overrides: { quality: string };
  count: number;
};

const ctx = createProxy<Ctx>();

describe('M2 intrinsics', () => {
  it('statesArrayGetItem', () => {
    const expr = statesArrayGetItem(ctx.scenes, ctx.index);
    expect(getExpression(expr)).toBe('States.ArrayGetItem($.scenes, $.index)');
    expectTypeOf(expr).toExtend<IntrinsicExpr<{ id: string }>>();

    // literal index
    expect(getExpression(statesArrayGetItem(ctx.frames, 0))).toBe(
      'States.ArrayGetItem($.frames, 0)',
    );
  });

  it('statesArrayContains', () => {
    const expr = statesArrayContains(ctx.frames, ctx.index);
    expect(getExpression(expr)).toBe('States.ArrayContains($.frames, $.index)');
    expectTypeOf(expr).toExtend<IntrinsicExpr<boolean>>();

    expect(getExpression(statesArrayContains(ctx.frames, 42))).toBe(
      'States.ArrayContains($.frames, 42)',
    );
  });

  it('statesArrayRange', () => {
    const expr = statesArrayRange(0, ctx.count, 10);
    expect(getExpression(expr)).toBe('States.ArrayRange(0, $.count, 10)');
    expectTypeOf(expr).toExtend<IntrinsicExpr<number[]>>();
  });

  it('statesArrayUnique', () => {
    const expr = statesArrayUnique(ctx.frames);
    expect(getExpression(expr)).toBe('States.ArrayUnique($.frames)');
    expectTypeOf(expr).toExtend<IntrinsicExpr<number[]>>();
  });

  it('statesArrayPartition', () => {
    const expr = statesArrayPartition(ctx.frames, 100);
    expect(getExpression(expr)).toBe('States.ArrayPartition($.frames, 100)');
    expectTypeOf(expr).toExtend<IntrinsicExpr<number[][]>>();
  });

  it('statesJsonMerge always emits the shallow-merge flag', () => {
    const expr = statesJsonMerge(ctx.defaults, ctx.overrides);
    expect(getExpression(expr)).toBe(
      'States.JsonMerge($.defaults, $.overrides, false)',
    );
    // b wins on conflicts: quality comes from overrides, width survives
    expectTypeOf(expr).toExtend<
      IntrinsicExpr<{ width: number; quality: string }>
    >();
  });

  it('statesMathRandom with and without seed', () => {
    expect(getExpression(statesMathRandom(1, ctx.count))).toBe(
      'States.MathRandom(1, $.count)',
    );
    expect(getExpression(statesMathRandom(1, 100, 42))).toBe(
      'States.MathRandom(1, 100, 42)',
    );
  });

  it('statesStringSplit quotes literal delimiters', () => {
    const expr = statesStringSplit(ctx.key, '/');
    expect(getExpression(expr)).toBe("States.StringSplit($.key, '/')");
    expectTypeOf(expr).toExtend<IntrinsicExpr<string[]>>();
  });

  it('statesBase64Encode / statesBase64Decode', () => {
    expect(getExpression(statesBase64Encode(ctx.key))).toBe(
      'States.Base64Encode($.key)',
    );
    expect(getExpression(statesBase64Decode(ctx.key))).toBe(
      'States.Base64Decode($.key)',
    );
  });

  it('statesHash quotes the algorithm', () => {
    const expr = statesHash(ctx.key, 'SHA-256');
    expect(getExpression(expr)).toBe("States.Hash($.key, 'SHA-256')");
    expectTypeOf(expr).toExtend<IntrinsicExpr<string>>();
  });

  it('rejects object literals as intrinsic arguments', () => {
    expect(() => statesArrayContains(ctx.scenes, { id: 'x' })).toThrow(
      'objects cannot appear as intrinsic function arguments',
    );
  });
});

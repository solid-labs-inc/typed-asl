/**
 * Negative type tests for the claims in README's "Type machinery worth
 * knowing": code that SHOULD NOT compile.
 *
 * Each `@ts-expect-error` is verified in both directions by `tsc --noEmit`
 * (which CI runs): if the API stops rejecting the code — including the
 * failure mode where inference silently degrades to `any` — the directive
 * becomes unused and compilation fails with TS2578. `expectTypeOf().not`
 * assertions can't catch the `any` case; these can.
 *
 * The bodies still execute under vitest, so each case either uses values
 * that are only wrong at the type level, or (where the library also guards
 * at runtime) asserts the runtime throw as well.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SequenceBuilder } from './builder.js';
import { statesArrayLength, statesMathAdd, statesFormat } from './intrinsic.js';
import { createProxy } from './proxy.js';

const Input = z.object({
  step: z.literal('do-thing'),
  bucket: z.string(),
  count: z.number(),
});

const Output = z.object({
  resultId: z.string(),
});

const config = {
  inputSchema: Input,
  outputSchema: Output,
  functionArn: '${lambda_function_arn}',
};

type Ctx = { bucket: string; key: string; size: number };

describe('type guarantees (negative cases)', () => {
  it('rejects a payload missing a required input field', () => {
    new SequenceBuilder<Ctx>().task(
      'doThing',
      config,
      // @ts-expect-error — `count` is required by the input schema
      (ctx) => ({
        step: 'do-thing' as const,
        bucket: ctx.bucket,
      }),
    );
  });

  it('rejects a payload with an extra field, at compile time and runtime', () => {
    expect(() =>
      new SequenceBuilder<Ctx>().task('doThing', config, (ctx) => ({
        step: 'do-thing' as const,
        bucket: ctx.bucket,
        count: ctx.size,
        // @ts-expect-error — `unexpected` is not in the input schema
        unexpected: ctx.key,
      })),
    ).toThrow('Payload field "unexpected" is not in the input schema');
  });

  it('rejects a ref whose type does not match the field', () => {
    new SequenceBuilder<Ctx>().task('doThing', config, (ctx) => ({
      step: 'do-thing' as const,
      // @ts-expect-error — `bucket` wants Ref<string>, ctx.size is Ref<number>
      bucket: ctx.size,
      count: ctx.size,
    }));
  });

  it('rejects a literal whose type does not match the field', () => {
    new SequenceBuilder<Ctx>().task('doThing', config, (ctx) => ({
      // @ts-expect-error — `step` must be the literal 'do-thing'
      step: 'wrong-step' as const,
      bucket: ctx.bucket,
      count: ctx.size,
    }));
  });

  it('rejects a ref to a context key that does not exist', () => {
    new SequenceBuilder<Ctx>().task('doThing', config, (ctx) => ({
      step: 'do-thing' as const,
      // @ts-expect-error — `ctx.missing` is not part of the context
      bucket: ctx.missing,
      count: ctx.size,
    }));
  });

  it('rejects out-of-range and cross-branch parallel indices', () => {
    new SequenceBuilder<Ctx>()
      .parallel('fanOut', [
        new SequenceBuilder<Ctx>().task('left', config, (ctx) => ({
          step: 'do-thing' as const,
          bucket: ctx.bucket,
          count: ctx.size,
        })),
        new SequenceBuilder<Ctx>().task('right', config, (ctx) => ({
          step: 'do-thing' as const,
          bucket: ctx.bucket,
          count: ctx.size,
        })),
      ])
      .pass('after', (ctx) => ({
        ok: ctx.fanOut[0].left.resultId,
        // @ts-expect-error — branch 1 has no `left` state, only `right`
        crossBranch: ctx.fanOut[1].left,
        // Known gap: an out-of-range index like ctx.fanOut[2] is NOT
        // rejected — the `Ref<T> &` intersection in Proxied defeats tuple
        // bounds checking. Tracked in docs/plan.md.
      }));
  });

  it('rejects a choice operand whose type does not match the operator', () => {
    new SequenceBuilder<Ctx>().choice('check', (ctx) => ({
      choices: [
        {
          // @ts-expect-error — stringEquals compares against a string
          when: { variable: ctx.bucket, stringEquals: 42 },
          then: (b) => b,
        },
      ],
    }));
  });

  it('rejects intrinsic arguments of the wrong type', () => {
    const ctx = createProxy<Ctx>();

    // @ts-expect-error — MathAdd needs a numeric ref, ctx.bucket is a string
    statesMathAdd(ctx.bucket, 1);

    // @ts-expect-error — ArrayLength needs an array ref
    statesArrayLength(ctx.size);

    // statesFormat interpolates refs of any type — this one must compile
    statesFormat('{}/{}', ctx.bucket, ctx.size);
  });
});

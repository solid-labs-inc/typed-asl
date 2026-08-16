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
import type { Proxied, Ref } from './types.js';

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

  it('rejects an extra field on the resultSelector overload too', () => {
    // The exact-key check lives in the shared ExactPayload alias, but an
    // overload could still regress independently — cover a second one.
    // The bad payload makes the resultSelector overload fail, so overload
    // resolution reports the error on the config argument, not the
    // payload line — the directive sits there. If the API stops
    // rejecting the extra field, the directive turns unused and tsc fails.
    expect(() =>
      new SequenceBuilder<Ctx>().task(
        'doThing',
        {
          ...config,
          // @ts-expect-error — the bad payload disqualifies this overload,
          // and TS pins the resulting error to this property
          resultSelector: (output) => ({ id: output.resultId }),
        },
        (ctx) => ({
          step: 'do-thing' as const,
          bucket: ctx.bucket,
          count: ctx.size,
          unexpected: ctx.key,
        }),
      ),
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
        // @ts-expect-error — the tuple has two branches, there is no index 2
        outOfRange: ctx.fanOut[2],
      }));
  });

  it('rejects cross-branch access with factory-form parallel branches', () => {
    new SequenceBuilder<Ctx>()
      .parallel('fanOut', [
        (b) =>
          b.task('left', config, (ctx) => ({
            step: 'do-thing' as const,
            bucket: ctx.bucket,
            count: ctx.size,
          })),
        (b) =>
          b.task('right', config, (ctx) => ({
            step: 'do-thing' as const,
            bucket: ctx.bucket,
            count: ctx.size,
          })),
      ])
      .pass('after', (ctx) => ({
        ok: ctx.fanOut[1].right.resultId,
        // @ts-expect-error — per-index inference must not degrade to a
        // union: branch 1 has no `left` state
        crossBranch: ctx.fanOut[1].left,
      }));
  });

  it('rejects a *Path choice operand whose ref type disagrees with the operator', () => {
    new SequenceBuilder<Ctx>().choice('check', (ctx) => ({
      choices: [
        {
          // @ts-expect-error — numericLessThanPath wants Ref<number>,
          // ctx.key is Ref<string>
          when: { variable: ctx.size, numericLessThanPath: ctx.key },
          then: (b) => b,
        },
      ],
    }));
  });

  it('rejects an auto-generated ResultSelector over an optional output field', () => {
    const OptionalOutput = z.object({
      resultId: z.string(),
      maybe: z.string().optional(),
    });
    // Static payload values: the config error un-types the callback's
    // ctx, and this case is about the output schema only.
    expect(() =>
      new SequenceBuilder<Ctx>().task(
        'doThing',
        // @ts-expect-error — optional output fields require an explicit
        // resultSelector (the auto-generated one errors at runtime on
        // absent keys)
        { ...config, outputSchema: OptionalOutput },
        () => ({ step: 'do-thing' as const, bucket: 'b', count: 1 }),
      ),
    ).toThrow('optional');
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

  it('rejects a choice variable whose type disagrees with the operator', () => {
    new SequenceBuilder<Ctx>().choice('check', (ctx) => ({
      choices: [
        {
          // @ts-expect-error — stringEquals wants a string variable,
          // ctx.size is Ref<number>
          when: { variable: ctx.size, stringEquals: 'x' },
          then: (b) => b,
        },
      ],
    }));
  });

  it('rejects context access via the state name when customTask stores elsewhere', () => {
    new SequenceBuilder<Ctx>()
      .customTask('transcode', {
        resource: 'arn:aws:states:::batch:submitJob',
        parameters: () => ({}),
        resultPath: '$.transcodeJob',
      })
      .pass('after', (ctx) => ({
        ok: ctx.transcodeJob,
        // @ts-expect-error — the result lives at $.transcodeJob, not at
        // the state name; ctx.transcode would be a dangling ref
        wrong: ctx.transcode,
      }));
  });

  it('rejects a map items selector that is a typo or not an array', () => {
    type MapCtx = Ctx & { scenes: { id: string }[] };
    // Pinned at the exact annotation the map() items overload uses —
    // overload-resolution error anchors are too unstable for directives
    // on a full map() call.
    type ItemsSelector = (ctx: Proxied<MapCtx>) => Ref<readonly unknown[]>;
    const valid: ItemsSelector = (ctx) => ctx.scenes;
    // @ts-expect-error — `scenez` is a typo, not a context key
    const typo: ItemsSelector = (ctx) => ctx.scenez;
    // @ts-expect-error — `bucket` is a string, not an array
    const notArray: ItemsSelector = (ctx) => ctx.bucket;
    void [valid, typo, notArray];
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

/**
 * Chapter 9: Choice — Conditional Branching with Convergence
 *
 * A Choice state evaluates conditions and routes execution to the matching
 * branch. In raw ASL, you have to manually wire each branch's terminal state
 * back to the convergence point — error-prone and tedious.
 *
 * The builder handles this automatically:
 *   - Non-terminal branches get their `End: true` replaced with `Next`
 *     pointing to the state after the choice (convergence).
 *   - Fail states remain terminal (no convergence needed).
 *   - Empty branches skip directly to the convergence point.
 *
 * Conditions support both simple comparisons (`stringEquals`, `numericEquals`,
 * `booleanEquals`, etc.) and compound logic (`and`, `or`, `not`).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { SequenceBuilder, serializeCondition } from '../src/index.js';
import type { ChoiceCondition } from '../src/index.js';
import { createProxy } from '../src/index.js';

describe('Chapter 9: Choice — Conditional Branching', () => {
  const LAMBDA_ARN = '${lambda_arn}';

  // ── Condition serialization ──────────────────────────────────────────

  it('simple conditions compare a variable against a value', () => {
    type Ctx = { assetType: string; frameCount: number; isReady: boolean };
    const ctx = createProxy<Ctx>();

    // String comparison
    const strCond: ChoiceCondition = {
      variable: ctx.assetType,
      stringEquals: 'video',
    };
    expect(serializeCondition(strCond)).toEqual({
      Variable: '$.assetType',
      StringEquals: 'video',
    });

    // Numeric comparison
    const numCond: ChoiceCondition = {
      variable: ctx.frameCount,
      numericGreaterThan: 0,
    };
    expect(serializeCondition(numCond)).toEqual({
      Variable: '$.frameCount',
      NumericGreaterThan: 0,
    });

    // Boolean comparison
    const boolCond: ChoiceCondition = {
      variable: ctx.isReady,
      booleanEquals: true,
    };
    expect(serializeCondition(boolCond)).toEqual({
      Variable: '$.isReady',
      BooleanEquals: true,
    });
  });

  it('compound conditions combine with and/or/not', () => {
    type Ctx = { type: string; size: number };
    const ctx = createProxy<Ctx>();

    const compound: ChoiceCondition = {
      and: [
        { variable: ctx.type, stringEquals: 'video' },
        { not: { variable: ctx.size, numericLessThan: 100 } },
      ],
    };

    expect(serializeCondition(compound)).toEqual({
      And: [
        { Variable: '$.type', StringEquals: 'video' },
        { Not: { Variable: '$.size', NumericLessThan: 100 } },
      ],
    });
  });

  // ── Choice with convergence ──────────────────────────────────────────

  it('branches automatically converge to the next state', () => {
    const ProcessVideoInput = z.object({
      step: z.literal('process-video'),
      assetType: z.string(),
    });
    const ProcessVideoOutput = z.object({ videoId: z.string() });

    const ProcessImageInput = z.object({
      step: z.literal('process-image'),
      assetType: z.string(),
    });
    const ProcessImageOutput = z.object({ imageId: z.string() });

    const FinalizeInput = z.object({
      step: z.literal('finalize'),
      assetType: z.string(),
    });
    const FinalizeOutput = z.object({ done: z.boolean() });

    type Input = { assetType: string };

    const asl = new SequenceBuilder<Input>()
      .choice('checkType', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.assetType, stringEquals: 'video' },
            then: (b) =>
              b.task(
                'processVideo',
                {
                  inputSchema: ProcessVideoInput,
                  outputSchema: ProcessVideoOutput,
                  functionArn: LAMBDA_ARN,
                },
                (c) => ({
                  step: 'process-video' as const,
                  assetType: c.assetType,
                }),
              ),
          },
          {
            when: { variable: ctx.assetType, stringEquals: 'image' },
            then: (b) =>
              b.task(
                'processImage',
                {
                  inputSchema: ProcessImageInput,
                  outputSchema: ProcessImageOutput,
                  functionArn: LAMBDA_ARN,
                },
                (c) => ({
                  step: 'process-image' as const,
                  assetType: c.assetType,
                }),
              ),
          },
        ],
        default: (b) =>
          b.fail('unknownType', {
            error: 'UnknownAssetType',
            cause: 'The asset type is not supported',
          }),
      }))
      // This task is the convergence point — both branches lead here
      .task(
        'finalize',
        {
          inputSchema: FinalizeInput,
          outputSchema: FinalizeOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({ step: 'finalize' as const, assetType: ctx.assetType }),
      )
      .build();

    // The Choice state routes to branches
    const choice = asl.States.CheckType as Record<string, any>;
    expect(choice.Type).toBe('Choice');
    expect(choice.Choices[0].StringEquals).toBe('video');
    expect(choice.Choices[0].Next).toBe('ProcessVideo');
    expect(choice.Choices[1].StringEquals).toBe('image');
    expect(choice.Choices[1].Next).toBe('ProcessImage');
    expect(choice.Default).toBe('UnknownType');

    // Non-terminal branches converge to Finalize (Next, not End)
    expect((asl.States.ProcessVideo as any).Next).toBe('Finalize');
    expect((asl.States.ProcessVideo as any).End).toBeUndefined();
    expect((asl.States.ProcessImage as any).Next).toBe('Finalize');

    // Fail state remains terminal — no convergence
    expect((asl.States.UnknownType as any).Type).toBe('Fail');
    expect((asl.States.UnknownType as any).Next).toBeUndefined();
    expect((asl.States.UnknownType as any).End).toBeUndefined();

    // Finalize is the last state
    expect((asl.States.Finalize as any).End).toBe(true);
  });

  // ── Empty branches skip to convergence ───────────────────────────────

  it('empty branches skip directly to the convergence point', () => {
    type Input = { flag: boolean };

    const DoWorkInput = z.object({ step: z.literal('do-work') });
    const DoWorkOutput = z.object({ result: z.string() });

    const asl = new SequenceBuilder<Input>()
      .choice('checkFlag', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.flag, booleanEquals: true },
            then: (b) =>
              b.task(
                'doWork',
                {
                  inputSchema: DoWorkInput,
                  outputSchema: DoWorkOutput,
                  functionArn: LAMBDA_ARN,
                },
                () => ({ step: 'do-work' as const }),
              ),
          },
        ],
        // Empty default branch — skips to whatever comes next
        default: (b) => b,
      }))
      .pass('done', { result: 'finished', resultPath: '$.status' })
      .build();

    const choice = asl.States.CheckFlag as Record<string, any>;
    // The "true" branch goes to DoWork
    expect(choice.Choices[0].Next).toBe('DoWork');
    // DoWork converges to Done
    expect((asl.States.DoWork as any).Next).toBe('Done');
    // The empty default branch skips directly to Done
    expect(choice.Default).toBe('Done');
  });

  // ── Choice with type assertion ───────────────────────────────────────

  it('choice<Adds>() asserts common fields across all branches', () => {
    type Input = { sceneCount: number };

    // When all branches set a common field, use the type parameter to
    // make it available in downstream context.
    const builder = new SequenceBuilder<Input>().choice<{
      isWholeVideo: boolean;
    }>('checkSceneCount', (ctx) => ({
      choices: [
        {
          when: { variable: ctx.sceneCount, numericEquals: 1 },
          then: (b) =>
            b.pass('setWhole', {
              result: true,
              resultPath: '$.isWholeVideo',
            }),
        },
      ],
      default: (b) =>
        b.pass('setNotWhole', {
          result: false,
          resultPath: '$.isWholeVideo',
        }),
    }));

    // After the choice, ctx.isWholeVideo is typed as boolean
    type Ctx = typeof builder._ctx;
    type IsWholeVideo = Ctx['isWholeVideo'];
    // (this is a type-level assertion — it compiles successfully)
    const _check: IsWholeVideo = true;
    expect(_check).toBe(true);
  });
});

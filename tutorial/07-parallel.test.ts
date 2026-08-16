/**
 * Chapter 7: Parallel — Tuple Typing, Not Unions
 *
 * Step Functions Parallel states run multiple branches concurrently.
 * The result is an array where index 0 is branch 0's output, index 1 is
 * branch 1's output, etc.
 *
 * A naive approach would type this as a union: `(BranchA | BranchB)[]`.
 * But that loses information — you can't safely access branch-specific
 * fields by index.
 *
 * Our builder types parallel results as a **tuple**:
 *   `[{ extractFrames: ... }, { transcode: ... }]`
 *
 * This means `ctx.process[0].extractFrames` and `ctx.process[1].transcode`
 * each have their own distinct type. The key mechanism is
 * `BranchOutputTuple<Base, Branches>`, which computes the *delta* each
 * branch added beyond the shared base context.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';

import { SequenceBuilder } from '../src/index.js';

describe('Chapter 7: Parallel — Tuple Typing', () => {
  // ── Shared schemas ───────────────────────────────────────────────────

  const StorageRef = z.object({ bucket: z.string(), key: z.string() });

  const ExtractFramesInput = z.object({
    step: z.literal('extract-frames'),
    bucket: z.string(),
    key: z.string(),
  });
  const ExtractFramesOutput = z.object({
    frameStorageRefs: z.array(StorageRef),
  });

  const TranscodeInput = z.object({
    step: z.literal('transcode'),
    bucket: z.string(),
    key: z.string(),
  });
  const TranscodeOutput = z.object({
    previewStorageRef: StorageRef,
  });

  const LAMBDA_ARN = '${lambda_arn}';

  type Input = { bucket: string; key: string };

  // ── Basic parallel ───────────────────────────────────────────────────

  it('parallel branches run concurrently and produce a tuple result', () => {
    const asl = new SequenceBuilder<Input>()
      .parallel('process', [
        // Branch 0: extract frames
        new SequenceBuilder<Input>().task(
          'extractFrames',
          {
            inputSchema: ExtractFramesInput,
            outputSchema: ExtractFramesOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'extract-frames' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        ),
        // Branch 1: transcode
        new SequenceBuilder<Input>().task(
          'transcode',
          {
            inputSchema: TranscodeInput,
            outputSchema: TranscodeOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'transcode' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        ),
      ])
      .build();

    const parallel = asl.States.Process as Record<string, any>;
    expect(parallel.Type).toBe('Parallel');
    expect(parallel.ResultPath).toBe('$.process');
    expect(parallel.Branches).toHaveLength(2);

    // Each branch is a full state machine
    expect(parallel.Branches[0].StartAt).toBe('ExtractFrames');
    expect(parallel.Branches[1].StartAt).toBe('Transcode');
  });

  // ── Tuple typing ─────────────────────────────────────────────────────

  it('parallel output is typed as a tuple, not a union', () => {
    const builder = new SequenceBuilder<Input>().parallel('process', [
      new SequenceBuilder<Input>().task(
        'extractFrames',
        {
          inputSchema: ExtractFramesInput,
          outputSchema: ExtractFramesOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'extract-frames' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      ),
      new SequenceBuilder<Input>().task(
        'transcode',
        {
          inputSchema: TranscodeInput,
          outputSchema: TranscodeOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'transcode' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      ),
    ]);

    // The context after .parallel() includes `process` as a tuple.
    // Each index corresponds to a branch's "delta" — the keys that branch
    // added beyond the shared base context (Input).
    type Ctx = typeof builder._ctx;

    // Branch 0's output (extractFrames) is at index 0
    expectTypeOf<Ctx['process'][0]>().toHaveProperty('extractFrames');

    // Branch 1's output (transcode) is at index 1
    expectTypeOf<Ctx['process'][1]>().toHaveProperty('transcode');
  });

  // ── Accessing parallel output in subsequent tasks ────────────────────

  it('subsequent tasks reference parallel output with typed tuple access', () => {
    const FinalizeInput = z.object({
      step: z.literal('finalize'),
      previewStorageRef: StorageRef,
      frameCount: z.number(),
    });
    const FinalizeOutput = z.object({ assetId: z.string() });

    const asl = new SequenceBuilder<Input>()
      .parallel('process', [
        new SequenceBuilder<Input>().task(
          'extractFrames',
          {
            inputSchema: ExtractFramesInput,
            outputSchema: ExtractFramesOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'extract-frames' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        ),
        new SequenceBuilder<Input>().task(
          'transcode',
          {
            inputSchema: TranscodeInput,
            outputSchema: TranscodeOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'transcode' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        ),
      ])
      .task(
        'finalize',
        {
          inputSchema: FinalizeInput,
          outputSchema: FinalizeOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          // Access branch 1's transcode output
          step: 'finalize' as const,
          previewStorageRef: ctx.process[1].transcode.previewStorageRef,
          // Static value (not from parallel output)
          frameCount: 30,
        }),
      )
      .build();

    const finalizePayload = (asl.States.Finalize as any).Parameters.Payload;
    expect(finalizePayload['previewStorageRef.$']).toBe(
      '$.process[1].transcode.previewStorageRef',
    );
    expect(finalizePayload.frameCount).toBe(30);
  });

  // ── Parallel with catch ──────────────────────────────────────────────

  it('parallel states can have catch handlers for error recovery', () => {
    const HandleErrorInput = z.object({
      step: z.literal('handle-error'),
      errorInfo: z.unknown(),
    });
    const HandleErrorOutput = z.object({ recovered: z.boolean() });

    const asl = new SequenceBuilder<Input>()
      .parallel(
        'process',
        [
          new SequenceBuilder<Input>().task(
            'extractFrames',
            {
              inputSchema: ExtractFramesInput,
              outputSchema: ExtractFramesOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({
              step: 'extract-frames' as const,
              bucket: ctx.bucket,
              key: ctx.key,
            }),
          ),
        ],
        {
          catch: [
            {
              errorEquals: ['States.TaskFailed'],
              resultPath: '$.error',
              handler: (b) =>
                b.task(
                  'handleError',
                  {
                    inputSchema: HandleErrorInput,
                    outputSchema: HandleErrorOutput,
                    functionArn: LAMBDA_ARN,
                  },
                  (ctx) => ({
                    step: 'handle-error' as const,
                    errorInfo: ctx.error,
                  }),
                ),
            },
          ],
        },
      )
      .build();

    const parallel = asl.States.Process as Record<string, any>;
    expect(parallel.Catch).toHaveLength(1);
    expect(parallel.Catch[0].ErrorEquals).toEqual(['States.TaskFailed']);
    expect(parallel.Catch[0].ResultPath).toBe('$.error');
    expect(parallel.Catch[0].Next).toBe('HandleError');

    // The catch handler is inlined as a sibling state
    expect(asl.States.HandleError).toBeDefined();
  });

  // ── Factory branches ─────────────────────────────────────────────────

  it('branches can be factory callbacks instead of prebuilt builders', () => {
    type Input = { bucket: string; key: string };

    // Instead of repeating `new SequenceBuilder<Input>()` per branch, pass
    // a callback — it receives a fresh builder already seeded with the
    // current context, exactly like `choice` branches. If an upstream
    // task changes the context type, the branches follow automatically.
    const asl = new SequenceBuilder<Input>()
      .parallel('process', [
        (b) =>
          b.task(
            'extractFrames',
            {
              inputSchema: ExtractFramesInput,
              outputSchema: ExtractFramesOutput,
              functionArn: '${lambda_arn}',
            },
            (ctx) => ({
              step: 'extract-frames' as const,
              bucket: ctx.bucket,
              key: ctx.key,
            }),
          ),
        // Both forms mix freely in one call.
        new SequenceBuilder<Input>().pass('mark', () => ({ marked: true })),
      ])
      .build();

    const parallel = asl.States.Process as { Branches: unknown[] };
    expect(parallel.Branches).toHaveLength(2);

    // Per-index typing works the same as with prebuilt builders:
    // ctx.process[0].extractFrames is branch 0's output, and accessing a
    // state from the wrong branch is a compile error.
  });
});

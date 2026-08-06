/**
 * Chapter 4: SequenceBuilder — Context Accumulation
 *
 * The `SequenceBuilder` is the core API. Each `.task()` call does two things:
 *
 *   1. **Runtime:** Records an ASL state definition in an internal array.
 *   2. **Compile time:** Returns the builder cast to a *wider* context type
 *      that includes the new task's output.
 *
 * So after `.task('runMediaInfo', ...)`, the context type grows from
 * `{ bucket, key }` to `{ bucket, key, runMediaInfo: MediaInfoOutput }`.
 * The next task's payload callback can then access `ctx.runMediaInfo.*`
 * with full type safety and autocomplete.
 *
 * If you reference a field that doesn't exist, or pass a Ref<string>
 * where Ref<number> is expected, TypeScript catches it at compile time.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';

import { SequenceBuilder, THROTTLE_RETRY } from '../src/index.js';

describe('Chapter 4: SequenceBuilder — Context Accumulation', () => {
  // ── Shared schemas for this chapter ──────────────────────────────────

  const LoadFileInput = z.object({
    step: z.literal('load-file'),
    bucket: z.string(),
    key: z.string(),
  });

  const LoadFileOutput = z.object({
    fileUpload: z.object({
      id: z.string(),
      filename: z.string(),
    }),
  });

  const AnalyzeInput = z.object({
    step: z.literal('analyze'),
    fileId: z.string(),
    filename: z.string(),
  });

  const AnalyzeOutput = z.object({
    width: z.number(),
    height: z.number(),
    duration: z.number(),
  });

  const LAMBDA_ARN = '${lambda_arn}';

  // ── Single task ──────────────────────────────────────────────────────

  it('a single task generates one ASL state with correct wiring', () => {
    type Input = { bucket: string; key: string };

    const asl = new SequenceBuilder<Input>()
      .task(
        'loadFile',
        {
          inputSchema: LoadFileInput,
          outputSchema: LoadFileOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'load-file' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .build();

    expect(asl.StartAt).toBe('LoadFile');
    expect(Object.keys(asl.States)).toEqual(['LoadFile']);

    const state = asl.States.LoadFile as Record<string, any>;
    expect(state.Type).toBe('Task');
    expect(state.ResultPath).toBe('$.loadFile');
    expect(state.End).toBe(true); // Last state ends the machine
  });

  // ── Two-task chain ───────────────────────────────────────────────────

  it('chaining tasks wires Next pointers and accumulates context', () => {
    type Input = { bucket: string; key: string };

    const asl = new SequenceBuilder<Input>()
      .task(
        'loadFile',
        {
          inputSchema: LoadFileInput,
          outputSchema: LoadFileOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          // ctx has: { bucket, key }
          step: 'load-file' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .task(
        'analyze',
        {
          inputSchema: AnalyzeInput,
          outputSchema: AnalyzeOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          // ctx now also has: { loadFile: { fileUpload: { id, filename } } }
          // We can reference the previous task's output!
          step: 'analyze' as const,
          fileId: ctx.loadFile.fileUpload.id,
          filename: ctx.loadFile.fileUpload.filename,
        }),
      )
      .build();

    // First state points to the second
    expect((asl.States.LoadFile as any).Next).toBe('Analyze');
    expect((asl.States.LoadFile as any).End).toBeUndefined();

    // Second state ends the machine
    expect((asl.States.Analyze as any).End).toBe(true);
    expect((asl.States.Analyze as any).Next).toBeUndefined();

    // The payload for 'analyze' references the loadFile output
    const analyzePayload = (asl.States.Analyze as any).Parameters.Payload;
    expect(analyzePayload['fileId.$']).toBe('$.loadFile.fileUpload.id');
    expect(analyzePayload['filename.$']).toBe('$.loadFile.fileUpload.filename');
  });

  // ── Context type grows with each task ────────────────────────────────

  it('context type widens after each task (type-level test)', () => {
    type Input = { bucket: string; key: string };

    const builder = new SequenceBuilder<Input>().task(
      'loadFile',
      {
        inputSchema: LoadFileInput,
        outputSchema: LoadFileOutput,
        functionArn: LAMBDA_ARN,
      },
      (ctx) => ({
        step: 'load-file' as const,
        bucket: ctx.bucket,
        key: ctx.key,
      }),
    );

    // After loadFile, the builder's context type is:
    //   Input & { loadFile: { fileUpload: { id: string; filename: string } } }
    type CtxAfterLoad = typeof builder._ctx;
    expectTypeOf<CtxAfterLoad>().toHaveProperty('bucket');
    expectTypeOf<CtxAfterLoad>().toHaveProperty('key');
    expectTypeOf<CtxAfterLoad>().toHaveProperty('loadFile');

    const builder2 = builder.task(
      'analyze',
      {
        inputSchema: AnalyzeInput,
        outputSchema: AnalyzeOutput,
        functionArn: LAMBDA_ARN,
      },
      (ctx) => ({
        step: 'analyze' as const,
        fileId: ctx.loadFile.fileUpload.id,
        filename: ctx.loadFile.fileUpload.filename,
      }),
    );

    // After analyze, context also includes analyze output:
    type CtxAfterAnalyze = typeof builder2._ctx;
    expectTypeOf<CtxAfterAnalyze>().toHaveProperty('bucket');
    expectTypeOf<CtxAfterAnalyze>().toHaveProperty('loadFile');
    expectTypeOf<CtxAfterAnalyze>().toHaveProperty('analyze');
  });

  // ── Pass state: reshaping data ───────────────────────────────────────

  it('pass() reshapes data and adds to context', () => {
    type Input = { bucket: string; key: string };

    const asl = new SequenceBuilder<Input>()
      .task(
        'loadFile',
        {
          inputSchema: LoadFileInput,
          outputSchema: LoadFileOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'load-file' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      // Use a Pass state to extract/reshape fields for downstream use
      .pass('summary', (ctx) => ({
        fileId: ctx.loadFile.fileUpload.id,
        filename: ctx.loadFile.fileUpload.filename,
        bucket: ctx.bucket,
      }))
      .build();

    const passState = asl.States.Summary as Record<string, any>;
    expect(passState.Type).toBe('Pass');
    expect(passState.ResultPath).toBe('$.summary');
    expect(passState.Parameters).toEqual({
      'fileId.$': '$.loadFile.fileUpload.id',
      'filename.$': '$.loadFile.fileUpload.filename',
      'bucket.$': '$.bucket',
    });
  });

  // ── Pass state: literal value ────────────────────────────────────────

  it('pass() can inject a literal value at a specific path', () => {
    const asl = new SequenceBuilder<{ count: number }>()
      .pass('setFlag', { result: true, resultPath: '$.isReady' })
      .build();

    const passState = asl.States.SetFlag as Record<string, any>;
    expect(passState.Type).toBe('Pass');
    expect(passState.Result).toBe(true);
    expect(passState.ResultPath).toBe('$.isReady');
  });

  // ── Retry configuration ──────────────────────────────────────────────

  it('tasks can include retry policies', () => {
    type Input = { bucket: string; key: string };

    const asl = new SequenceBuilder<Input>()
      .task(
        'loadFile',
        {
          inputSchema: LoadFileInput,
          outputSchema: LoadFileOutput,
          functionArn: LAMBDA_ARN,
          retry: THROTTLE_RETRY,
        },
        (ctx) => ({
          step: 'load-file' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .build();

    const state = asl.States.LoadFile as Record<string, any>;
    expect(state.Retry).toBeDefined();
    expect(state.Retry[0].ErrorEquals).toContain('ThrottlingException');
  });
});

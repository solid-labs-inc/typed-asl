/**
 * Chapter 10: Reusable Compositions via .pipe()
 *
 * As pipelines grow, you'll want to extract common sequences into reusable
 * functions. The `.pipe()` method enables this while maintaining type safety.
 *
 * A pipe function takes a `SequenceBuilder<Ctx>` (constrained to require
 * certain upstream outputs) and returns a `SequenceBuilder<NewCtx>` with
 * additional states appended. This keeps the chain flat and readable while
 * letting you reuse task sequences across different pipelines.
 *
 * The key insight is that pipe functions are *generic* — they constrain
 * what the context must contain (via `extends`) without caring about what
 * else is in it. This makes them composable with any pipeline that satisfies
 * their requirements.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';

import { SequenceBuilder } from '../src/index.js';

describe('Chapter 10: Reusable Compositions via .pipe()', () => {
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

  const CreateAtlasInput = z.object({
    step: z.literal('create-atlas'),
    frameStorageRefs: z.array(StorageRef),
    outputFilename: z.string(),
  });
  const CreateAtlasOutput = z.object({
    atlasStorageRef: StorageRef,
  });

  const GenerateEmbeddingInput = z.object({
    step: z.literal('generate-embedding'),
    frameStorageRefs: z.array(StorageRef),
  });
  const GenerateEmbeddingOutput = z.object({
    embedding: z.array(z.number()),
  });

  const LAMBDA_ARN = '${lambda_arn}';

  type StorageRefType = z.infer<typeof StorageRef>;

  // ── Defining a reusable pipe function ────────────────────────────────

  // This function can be used in any pipeline that has extracted frames.
  // The generic constraint ensures `ctx.extractFrames.frameStorageRefs` exists.
  const addCreateAtlas = <
    Ctx extends { extractFrames: { frameStorageRefs: StorageRefType[] } },
  >(
    b: SequenceBuilder<Ctx>,
  ) =>
    b.task(
      'createAtlas',
      {
        inputSchema: CreateAtlasInput,
        outputSchema: CreateAtlasOutput,
        functionArn: LAMBDA_ARN,
      },
      (ctx) => ({
        step: 'create-atlas' as const,
        frameStorageRefs: ctx.extractFrames.frameStorageRefs,
        outputFilename: 'atlas.webp',
      }),
    );

  // Another reusable function — generates embeddings from extracted frames.
  const addGenerateEmbedding = <
    Ctx extends { extractFrames: { frameStorageRefs: StorageRefType[] } },
  >(
    b: SequenceBuilder<Ctx>,
  ) =>
    b.task(
      'generateEmbedding',
      {
        inputSchema: GenerateEmbeddingInput,
        outputSchema: GenerateEmbeddingOutput,
        functionArn: LAMBDA_ARN,
      },
      (ctx) => ({
        step: 'generate-embedding' as const,
        frameStorageRefs: ctx.extractFrames.frameStorageRefs,
      }),
    );

  // ── Using pipe ───────────────────────────────────────────────────────

  it('.pipe() applies a reusable function while keeping a flat chain', () => {
    type Input = { bucket: string; key: string };

    const asl = new SequenceBuilder<Input>()
      .task(
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
      )
      // Instead of inlining the createAtlas task, pipe it in
      .pipe(addCreateAtlas)
      .build();

    // The pipeline is: ExtractFrames → CreateAtlas
    expect(asl.StartAt).toBe('ExtractFrames');
    expect((asl.States.ExtractFrames as any).Next).toBe('CreateAtlas');
    expect((asl.States.CreateAtlas as any).End).toBe(true);

    // The createAtlas payload correctly references extractFrames output
    const atlasPayload = (asl.States.CreateAtlas as any).Parameters.Payload;
    expect(atlasPayload['frameStorageRefs.$']).toBe(
      '$.extractFrames.frameStorageRefs',
    );
  });

  // ── Composing multiple pipe functions ────────────────────────────────

  it('multiple pipe functions can be chained', () => {
    type Input = { bucket: string; key: string };

    const asl = new SequenceBuilder<Input>()
      .task(
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
      )
      .pipe(addCreateAtlas)
      .pipe(addGenerateEmbedding)
      .build();

    // ExtractFrames → CreateAtlas → GenerateEmbedding
    expect((asl.States.ExtractFrames as any).Next).toBe('CreateAtlas');
    expect((asl.States.CreateAtlas as any).Next).toBe('GenerateEmbedding');
    expect((asl.States.GenerateEmbedding as any).End).toBe(true);
  });

  // ── Context flows through pipes ──────────────────────────────────────

  it('context type accumulates through piped functions', () => {
    type Input = { bucket: string; key: string };

    const builder = new SequenceBuilder<Input>()
      .task(
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
      )
      .pipe(addCreateAtlas)
      .pipe(addGenerateEmbedding);

    // The context now includes everything from all three steps
    type Ctx = typeof builder._ctx;
    expectTypeOf<Ctx>().toHaveProperty('bucket');
    expectTypeOf<Ctx>().toHaveProperty('extractFrames');
    expectTypeOf<Ctx>().toHaveProperty('createAtlas');
    expectTypeOf<Ctx>().toHaveProperty('generateEmbedding');
  });

  // ── Pipe functions enforce constraints ───────────────────────────────

  it('pipe functions require their context constraints to be satisfied', () => {
    // This is a compile-time guarantee. If you try to pipe addCreateAtlas
    // into a builder that doesn't have extractFrames in context, TypeScript
    // will produce a type error.
    //
    // For example, this would NOT compile:
    //
    //   new SequenceBuilder<{ bucket: string }>()
    //     .pipe(addCreateAtlas)  // ERROR: missing extractFrames
    //
    // The generic constraint `Ctx extends { extractFrames: { ... } }` ensures
    // the pipe function is only used where its dependencies are met.

    // Verify the constraint is working by checking that a builder with the
    // required context is assignable to the function's parameter type:
    type HasFrames = { extractFrames: { frameStorageRefs: StorageRefType[] } };
    expectTypeOf<SequenceBuilder<HasFrames>>().toExtend<
      Parameters<typeof addCreateAtlas>[0]
    >();
  });
});

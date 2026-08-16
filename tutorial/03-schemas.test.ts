/**
 * Chapter 3: Zod Schemas as the Contract
 *
 * Each Lambda in the pipeline has an input schema and an output schema,
 * defined with Zod. These schemas serve double duty:
 *
 *   1. **TypedPayloadMapping** — The input schema's shape determines what
 *      fields the payload function must provide (and their types).
 *
 *   2. **ResultSelector auto-generation** — The output schema describes the
 *      *actual* Lambda response. Its keys are used to generate
 *      `{ "key.$": "$.Payload.key" }` mappings that extract the response
 *      into the state data.
 *
 *   3. **Typed ResultSelector** — When the Lambda's response needs remapping
 *      (e.g. renaming fields), a `resultSelector` function receives a typed
 *      proxy of the output schema and returns the desired context shape.
 *      The returned mapping's type becomes the context contribution.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { InferContext, Ref, TypedPayloadMapping } from '../src/index.js';
import { SequenceBuilder } from '../src/index.js';

describe('Chapter 3: Zod Schemas as the Contract', () => {
  // ── Schemas define Lambda contracts ──────────────────────────────────

  // A typical Lambda input schema.
  const RunMediaInfoInput = z.object({
    bucket: z.string(),
    key: z.string(),
  });

  const RunMediaInfoOutput = z.object({
    mediaInfo: z.object({
      width: z.number(),
      height: z.number(),
      duration: z.number(),
    }),
    assetType: z.string(),
  });

  // ── TypedPayloadMapping ──────────────────────────────────────────────

  it('TypedPayloadMapping includes all fields from the schema', () => {
    // TypedPayloadMapping<InputSchema> produces an object type where
    // every field (including the discriminator) accepts either a static
    // value OR a Ref<T>.
    type Mapping = TypedPayloadMapping<typeof RunMediaInfoInput>;

    // The mapping requires `bucket`, and `key`
    expectTypeOf<Mapping>().toHaveProperty('bucket');
    expectTypeOf<Mapping>().toHaveProperty('key');

    // Each field accepts either a literal value or a typed Ref
    type BucketField = Mapping['bucket'];
    expectTypeOf<string>().toExtend<BucketField>();
    expectTypeOf<Ref<string>>().toExtend<BucketField>();
  });

  // ── Discriminator is passed explicitly ────────────────────────────────

  it('the payload callback includes the discriminator explicitly', () => {
    type Input = { bucket: string; key: string };

    const asl = new SequenceBuilder<Input>()
      .task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: '${lambda_arn}',
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .build();

    const payload = (asl.States.RunMediaInfo as Record<string, any>).Parameters
      .Payload;
    expect(payload['bucket.$']).toBe('$.bucket');
    expect(payload['key.$']).toBe('$.key');
  });

  // ── Extra fields are rejected ────────────────────────────────────────

  it('a payload field that is not in the input schema is rejected', () => {
    type Input = { bucket: string; key: string };

    // The payload must match the schema *exactly*: a missing required
    // field is a compile error, and so is an extra one. An extra field
    // is usually a typo — and it would be sent to the Lambda without ever
    // being validated. The same check exists at runtime for plain-JS
    // callers, which is what this test exercises.
    expect(() =>
      new SequenceBuilder<Input>().task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: '${lambda_arn}',
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
          // @ts-expect-error — `bukcet` is not in RunMediaInfoInput
          bukcet: ctx.bucket,
        }),
      ),
    ).toThrow('Payload field "bukcet" is not in the input schema');
  });

  // ── ResultSelector auto-generation ───────────────────────────────────

  it('output schema keys are auto-mapped to $.Payload.{key}', () => {
    type Input = { bucket: string; key: string };

    const asl = new SequenceBuilder<Input>()
      .task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: '${lambda_arn}',
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .build();

    // The ResultSelector is auto-generated from the output schema's keys.
    // Each key gets `"key.$": "$.Payload.key"` so the Lambda response
    // (which lives under $.Payload) is extracted into the state data.
    const resultSelector = (asl.States.RunMediaInfo as Record<string, any>)
      .ResultSelector;
    expect(resultSelector).toEqual({
      'mediaInfo.$': '$.Payload.mediaInfo',
      'assetType.$': '$.Payload.assetType',
    });
  });

  // ── Typed resultSelector for field remapping ─────────────────────────

  it('resultSelector function remaps Lambda output to desired context shape', () => {
    // The output schema describes what the Lambda *actually* returns.
    // Here the Lambda returns `{ outputStorageRef: { ... } }`.
    const UploadOutput = z.object({
      outputStorageRef: z.object({ bucket: z.string(), key: z.string() }),
    });

    // The resultSelector function receives a typed proxy of the Lambda
    // output and returns the shape we want in our context.
    // `output.outputStorageRef` is type-safe — it references a real field.
    const builder = new SequenceBuilder<{ url: string }>().task(
      'upload',
      {
        inputSchema: z.object({ url: z.string() }),
        outputSchema: UploadOutput,
        functionArn: '${lambda_arn}',
        resultSelector: (output) => ({
          storageRef: output.outputStorageRef,
        }),
      },
      (ctx) => ({ url: ctx.url }),
    );
    type Output = InferContext<typeof builder>;

    // The context type comes from the resultSelector return — it has `storageRef`
    // (not `outputStorageRef` from the Lambda output)
    expectTypeOf<Output>().toExtend<{
      url: string;
      upload: {
        storageRef: { bucket: string; key: string };
      };
    }>();

    const asl = builder.build();

    // The ASL ResultSelector maps from the Lambda's actual field name
    // to the desired context key.
    const resultSelector = (asl.States.Upload as Record<string, any>)
      .ResultSelector;
    expect(resultSelector).toEqual({
      'storageRef.$': '$.Payload.outputStorageRef',
    });
  });

  // ── Optional output fields require an explicit resultSelector ────────

  it('optional output fields cannot use the auto-generated selector', () => {
    // The auto-generated ResultSelector references every output schema
    // key, and JSONPath-mode ASL errors at runtime when a referenced key
    // is absent. So a schema with .optional() fields must pass an
    // explicit resultSelector — this is enforced at compile time (the
    // config stops typechecking) and at build time:
    const TranscribeOutput = z.object({
      transcript: z.string().optional(),
      language: z.string(),
    });
    type Input = { videoId: string };

    expect(() =>
      new SequenceBuilder<Input>().task(
        'transcribe',
        // @ts-expect-error — optional `transcript` demands an explicit
        // resultSelector; the compiler error names the requirement
        {
          inputSchema: z.object({ videoId: z.string() }),
          outputSchema: TranscribeOutput,
          functionArn: '${lambda_arn}',
        },
        () => ({ videoId: 'v1' }),
      ),
    ).toThrow('optional');

    // The fix: select only what the Lambda always returns (or reshape
    // however you like — the selector is yours).
    const asl = new SequenceBuilder<Input>()
      .task(
        'transcribe',
        {
          inputSchema: z.object({ videoId: z.string() }),
          outputSchema: TranscribeOutput,
          functionArn: '${lambda_arn}',
          resultSelector: (output) => ({ language: output.language }),
        },
        (ctx) => ({ videoId: ctx.videoId }),
      )
      .build();

    expect(
      (asl.States.Transcribe as Record<string, unknown>).ResultSelector,
    ).toEqual({ 'language.$': '$.Payload.language' });
  });
});

/**
 * Chapter 0: The Problem
 *
 * AWS Step Functions are defined in Amazon States Language (ASL) — a JSON
 * format where references between states are raw JSONPath strings like
 * "$.runMediaInfo.width". These strings are completely untyped: the compiler
 * can't tell you if you misspelled a path, referenced a field that doesn't
 * exist, or passed a string where a number was expected.
 *
 * This chapter shows what raw ASL looks like and why it's fragile.
 */
import { describe, it, expect } from 'vitest';

describe('Chapter 0: The Problem with Raw ASL', () => {
  // ── What raw ASL looks like ──────────────────────────────────────────

  it('raw ASL uses untyped JSONPath strings to wire states together', () => {
    // This is a simplified Step Functions definition with two Lambda tasks.
    // The second task references output from the first via JSONPath strings.
    const rawAsl = {
      StartAt: 'RunMediaInfo',
      States: {
        RunMediaInfo: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          Parameters: {
            FunctionName: '${lambda_arn}',
            Payload: {
              step: 'run-mediainfo',
              'bucket.$': '$.bucket',
              'key.$': '$.key',
            },
          },
          ResultSelector: {
            'mediaInfo.$': '$.Payload.mediaInfo',
            'assetType.$': '$.Payload.assetType',
          },
          ResultPath: '$.runMediaInfo',
          Next: 'CreateVideo',
        },
        CreateVideo: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          Parameters: {
            FunctionName: '${lambda_arn}',
            Payload: {
              step: 'create-video',
              // These JSONPath strings reference the previous task's output.
              // They're just strings — nothing validates them at compile time.
              'width.$': '$.runMediaInfo.mediaInfo.width',
              'height.$': '$.runMediaInfo.mediaInfo.height',
            },
          },
          ResultSelector: {
            'videoId.$': '$.Payload.videoId',
          },
          ResultPath: '$.createVideo',
          End: true,
        },
      },
    };

    // The ASL is valid JSON — but the compiler tells us nothing about whether
    // '$.runMediaInfo.mediaInfo.width' actually exists or is a number.
    expect(rawAsl.States.CreateVideo.Parameters.Payload['width.$']).toBe(
      '$.runMediaInfo.mediaInfo.width'
    );
  });

  // ── The silent breakage ──────────────────────────────────────────────

  it('a typo in a JSONPath is invisible until runtime', () => {
    // Imagine we rename the Lambda's output field from "mediaInfo" to "media".
    // Every JSONPath referencing "$.runMediaInfo.mediaInfo" is now broken.
    // The compiler won't catch this — it's just a string.

    const brokenPayload = {
      step: 'create-video',
      'width.$': '$.runMediaInfo.mediaInfo.width', // BUG: should be "media"
      'height.$': '$.runMediaInfo.mediaInfo.height', // BUG: same
    };

    // TypeScript is happy. The state machine will fail at runtime with a
    // cryptic "JSONPath '$.runMediaInfo.mediaInfo.width' returned no results"
    // error, probably at 2am in production.
    expect(typeof brokenPayload['width.$']).toBe('string');
  });

  // ── What we want instead ─────────────────────────────────────────────

  it('what if the compiler could catch this?', () => {
    // The ideal developer experience would look something like this:
    //
    //   builder
    //     .task('runMediaInfo', { inputSchema, outputSchema, ... }, ctx => ({
    //       bucket: ctx.bucket,          // autocomplete, typed as Ref<string>
    //       key: ctx.key,
    //     }))
    //     .task('createVideo', { inputSchema, outputSchema, ... }, ctx => ({
    //       width: ctx.runMediaInfo.media.width,   // TS error if field doesn't exist
    //       height: ctx.runMediaInfo.media.height,  // type-checked as Ref<number>
    //     }))
    //     .build()
    //
    // To get there, we need:
    //   1. A type that carries both a JSONPath and its TypeScript type (Ref<T>)
    //   2. A way to trace property access into JSONPath strings (Proxied<T>)
    //   3. Schemas that define each Lambda's input/output contract (Zod)
    //   4. A builder that accumulates context types as states are added
    //   5. Serialization that turns typed refs back into ASL JSONPath strings
    //
    // The following chapters build these pieces one at a time.
    expect(true).toBe(true);
  });
});

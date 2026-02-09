import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_RETRY,
  type RetryConfig,
  SequenceBuilder,
  THROTTLE_RETRY,
} from './builder.js';
import {
  getExpression,
  statesFormat,
  statesJsonToString,
} from './intrinsic.js';
import { createMapItemProxy, pathOf } from './proxy.js';
import type { Proxied, Ref, TypedPayloadMapping } from './types.js';

// ── Test schemas ────────────────────────────────────────────────────

const StorageRefSchema = z.object({ bucket: z.string(), key: z.string() });

const LoadFileUploadInput = z.object({
  step: z.literal('load-file-upload'),
  bucket: z.string(),
  key: z.string(),
});

const LoadFileUploadOutput = z.object({
  fileUpload: z.object({
    id: z.string(),
    organizationId: z.string(),
    filename: z.string(),
  }),
});

const RunMediaInfoInput = z.object({
  step: z.literal('run-mediainfo'),
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

const CreateVideoInput = z.object({
  step: z.literal('create-video-for-file'),
  fileUpload: z.object({
    id: z.string(),
    organizationId: z.string(),
    filename: z.string(),
  }),
  mediaInfo: z.object({
    width: z.number(),
    height: z.number(),
    duration: z.number(),
  }),
});

const CreateVideoOutput = z.object({
  video: z.object({ id: z.string() }),
  width: z.number(),
  height: z.number(),
});

const TranscribeInput = z.object({
  step: z.literal('transcribe-video'),
  videoId: z.string(),
  audioStorageRef: StorageRefSchema.nullable(),
});

const TranscribeOutput = z.object({
  transcript: z.string().nullable(),
});

// ── Parallel test schemas ───────────────────────────────────────────

const ExtractFramesInput = z.object({
  step: z.literal('extract-frames'),
  bucket: z.string(),
  key: z.string(),
});

const ExtractFramesOutput = z.object({
  frameStorageRefs: z.array(StorageRefSchema),
  width: z.number(),
});

const TranscodePreviewInput = z.object({
  step: z.literal('transcode-preview'),
  bucket: z.string(),
  key: z.string(),
});

const TranscodePreviewOutput = z.object({
  previewStorageRef: StorageRefSchema,
});

const FinalizeInput = z.object({
  step: z.literal('finalize'),
  width: z.number(),
  previewStorageRef: StorageRefSchema,
});

const FinalizeOutput = z.object({
  assetId: z.string(),
});

const GenerateEmbeddingInput = z.object({
  step: z.literal('generate-embedding'),
  frameStorageRefs: z.array(StorageRefSchema),
});

const GenerateEmbeddingOutput = z.object({
  embedding: z.array(z.number()),
});

const LAMBDA_ARN = '${lambda_function_arn}';

// ── Runtime behavior ────────────────────────────────────────────────

describe('SequenceBuilder', () => {
  describe('build', () => {
    it('should throw if no states are added', () => {
      const builder = new SequenceBuilder();
      expect(() => builder.build()).toThrow('SequenceBuilder has no states');
    });

    it('should produce a single state with End: true', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
            retry: DEFAULT_RETRY,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .build();

      expect(result.StartAt).toBe('LoadFileUpload');
      expect(Object.keys(result.States)).toEqual(['LoadFileUpload']);

      const state = result.States['LoadFileUpload'] as Record<string, unknown>;
      expect(state['Type']).toBe('Task');
      expect(state['Resource']).toBe('arn:aws:states:::lambda:invoke');
      expect(state['ResultPath']).toBe('$.loadFileUpload');
      expect(state['End']).toBe(true);
      expect(state).not.toHaveProperty('Next');
    });

    it('should wire Next between sequential states', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .task(
          'runMediaInfo',
          {
            inputSchema: RunMediaInfoInput,
            outputSchema: RunMediaInfoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .build();

      expect(result.StartAt).toBe('LoadFileUpload');

      const first = result.States['LoadFileUpload'] as Record<string, unknown>;
      expect(first['Next']).toBe('RunMediaInfo');
      expect(first).not.toHaveProperty('End');

      const second = result.States['RunMediaInfo'] as Record<string, unknown>;
      expect(second['End']).toBe(true);
      expect(second).not.toHaveProperty('Next');
    });

    it('should wire a three-state chain correctly', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .task(
          'runMediaInfo',
          {
            inputSchema: RunMediaInfoInput,
            outputSchema: RunMediaInfoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .task(
          'createVideo',
          {
            inputSchema: CreateVideoInput,
            outputSchema: CreateVideoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            fileUpload: ctx.loadFileUpload.fileUpload,
            mediaInfo: ctx.runMediaInfo.mediaInfo,
          })
        )
        .build();

      expect(result.StartAt).toBe('LoadFileUpload');

      const s1 = result.States['LoadFileUpload'] as Record<string, unknown>;
      expect(s1['Next']).toBe('RunMediaInfo');

      const s2 = result.States['RunMediaInfo'] as Record<string, unknown>;
      expect(s2['Next']).toBe('CreateVideo');

      const s3 = result.States['CreateVideo'] as Record<string, unknown>;
      expect(s3['End']).toBe(true);
    });
  });

  describe('payload generation', () => {
    it('should auto-fill step literal from the input schema', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'runMediaInfo',
          {
            inputSchema: RunMediaInfoInput,
            outputSchema: RunMediaInfoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .build();

      const state = result.States['RunMediaInfo'] as Record<string, unknown>;
      const params = state['Parameters'] as Record<string, unknown>;
      const payload = params['Payload'] as Record<string, unknown>;

      expect(payload['step']).toBe('run-mediainfo');
    });

    it('should convert Ref values to JSONPath entries', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .build();

      const state = result.States['LoadFileUpload'] as Record<string, unknown>;
      const params = state['Parameters'] as Record<string, unknown>;
      const payload = params['Payload'] as Record<string, unknown>;

      expect(payload['bucket.$']).toBe('$.bucket');
      expect(payload['key.$']).toBe('$.key');
      // Static step value should NOT have .$
      expect(payload['step']).toBe('load-file-upload');
      expect(payload).not.toHaveProperty('step.$');
    });

    it('should keep static values as-is', () => {
      type Ctx = {
        videoId: string;
        audioStorageRef: { bucket: string; key: string } | null;
      };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'transcribe',
          {
            inputSchema: TranscribeInput,
            outputSchema: TranscribeOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            videoId: ctx.videoId,
            audioStorageRef: null,
          })
        )
        .build();

      const state = result.States['Transcribe'] as Record<string, unknown>;
      const params = state['Parameters'] as Record<string, unknown>;
      const payload = params['Payload'] as Record<string, unknown>;

      expect(payload['videoId.$']).toBe('$.videoId');
      expect(payload['audioStorageRef']).toBeNull();
      expect(payload).not.toHaveProperty('audioStorageRef.$');
    });

    it('should reference upstream state outputs in payload', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .task(
          'runMediaInfo',
          {
            inputSchema: RunMediaInfoInput,
            outputSchema: RunMediaInfoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .task(
          'createVideo',
          {
            inputSchema: CreateVideoInput,
            outputSchema: CreateVideoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            fileUpload: ctx.loadFileUpload.fileUpload,
            mediaInfo: ctx.runMediaInfo.mediaInfo,
          })
        )
        .build();

      const state = result.States['CreateVideo'] as Record<string, unknown>;
      const params = state['Parameters'] as Record<string, unknown>;
      const payload = params['Payload'] as Record<string, unknown>;

      expect(payload['step']).toBe('create-video-for-file');
      expect(payload['fileUpload.$']).toBe('$.loadFileUpload.fileUpload');
      expect(payload['mediaInfo.$']).toBe('$.runMediaInfo.mediaInfo');
    });
  });

  describe('result selector', () => {
    it('should auto-generate from the output schema', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'runMediaInfo',
          {
            inputSchema: RunMediaInfoInput,
            outputSchema: RunMediaInfoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .build();

      const state = result.States['RunMediaInfo'] as Record<string, unknown>;
      expect(state['ResultSelector']).toEqual({
        'mediaInfo.$': '$.Payload.mediaInfo',
        'assetType.$': '$.Payload.assetType',
      });
    });
  });

  describe('retry config', () => {
    it('should include retry when provided', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
            retry: DEFAULT_RETRY,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .build();

      const state = result.States['LoadFileUpload'] as Record<string, unknown>;
      expect(state['Retry']).toEqual(DEFAULT_RETRY);
    });

    it('should omit retry when not provided', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .build();

      const state = result.States['LoadFileUpload'] as Record<string, unknown>;
      expect(state).not.toHaveProperty('Retry');
    });

    it('should support THROTTLE_RETRY preset', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
            retry: THROTTLE_RETRY,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .build();

      const state = result.States['LoadFileUpload'] as Record<string, unknown>;
      const retry = state['Retry'] as RetryConfig[];
      expect(retry).toHaveLength(2);
      expect(retry[0].ErrorEquals).toContain('ThrottlingException');
    });
  });

  describe('parallel', () => {
    it('should produce a Parallel state with branches', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .parallel('process', [
          new SequenceBuilder<Ctx>().task(
            'extractFrames',
            {
              inputSchema: ExtractFramesInput,
              outputSchema: ExtractFramesOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
          ),
          new SequenceBuilder<Ctx>().task(
            'transcodePreview',
            {
              inputSchema: TranscodePreviewInput,
              outputSchema: TranscodePreviewOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
          ),
        ])
        .build();

      expect(result.StartAt).toBe('Process');

      const state = result.States['Process'] as Record<string, unknown>;
      expect(state['Type']).toBe('Parallel');
      expect(state['ResultPath']).toBe('$.process');
      expect(state['End']).toBe(true);

      const branches = state['Branches'] as {
        StartAt: string;
        States: Record<string, unknown>;
      }[];
      expect(branches).toHaveLength(2);

      expect(branches[0].StartAt).toBe('ExtractFrames');
      expect(branches[0].States['ExtractFrames']).toBeDefined();

      expect(branches[1].StartAt).toBe('TranscodePreview');
      expect(branches[1].States['TranscodePreview']).toBeDefined();
    });

    it('should wire parallel followed by a task', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .parallel('process', [
          new SequenceBuilder<Ctx>().task(
            'extractFrames',
            {
              inputSchema: ExtractFramesInput,
              outputSchema: ExtractFramesOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
          ),
          new SequenceBuilder<Ctx>().task(
            'transcodePreview',
            {
              inputSchema: TranscodePreviewInput,
              outputSchema: TranscodePreviewOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
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
            width: ctx.process[0].extractFrames.width,
            previewStorageRef:
              ctx.process[1].transcodePreview.previewStorageRef,
          })
        )
        .build();

      const parallel = result.States['Process'] as Record<string, unknown>;
      expect(parallel['Next']).toBe('Finalize');
      expect(parallel).not.toHaveProperty('End');

      const finalize = result.States['Finalize'] as Record<string, unknown>;
      expect(finalize['End']).toBe(true);
    });

    it('should support nested parallel inside a branch', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .parallel('outer', [
          // Branch 0: task → nested parallel
          new SequenceBuilder<Ctx>()
            .task(
              'extractFrames',
              {
                inputSchema: ExtractFramesInput,
                outputSchema: ExtractFramesOutput,
                functionArn: LAMBDA_ARN,
              },
              (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
            )
            .parallel('descriptions', [
              new SequenceBuilder<
                Ctx & {
                  extractFrames: {
                    frameStorageRefs: { bucket: string; key: string }[];
                    width: number;
                  };
                }
              >().task(
                'generateEmbedding',
                {
                  inputSchema: GenerateEmbeddingInput,
                  outputSchema: GenerateEmbeddingOutput,
                  functionArn: LAMBDA_ARN,
                },
                (ctx) => ({
                  frameStorageRefs: ctx.extractFrames.frameStorageRefs,
                })
              ),
            ]),
          // Branch 1: single task
          new SequenceBuilder<Ctx>().task(
            'transcodePreview',
            {
              inputSchema: TranscodePreviewInput,
              outputSchema: TranscodePreviewOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
          ),
        ])
        .build();

      const outer = result.States['Outer'] as Record<string, unknown>;
      expect(outer['Type']).toBe('Parallel');

      const branches = outer['Branches'] as {
        StartAt: string;
        States: Record<string, unknown>;
      }[];
      expect(branches).toHaveLength(2);

      // Branch 0 should have two states: extractFrames → descriptions
      expect(branches[0].StartAt).toBe('ExtractFrames');
      expect(Object.keys(branches[0].States)).toEqual([
        'ExtractFrames',
        'Descriptions',
      ]);

      // The nested parallel
      const nested = branches[0].States['Descriptions'] as Record<
        string,
        unknown
      >;
      expect(nested['Type']).toBe('Parallel');
      expect(nested['End']).toBe(true);

      const nestedBranches = nested['Branches'] as {
        StartAt: string;
        States: Record<string, unknown>;
      }[];
      expect(nestedBranches).toHaveLength(1);
      expect(nestedBranches[0].StartAt).toBe('GenerateEmbedding');
    });
  });

  describe('pass', () => {
    it('should produce a Pass state with Parameters', () => {
      type Ctx = {
        scene: { id: string; start_seconds: number; end_seconds: number };
        createVideoAsset: { videoId: string };
      };

      const result = new SequenceBuilder<Ctx>()
        .pass('filterOutput', (ctx) => ({
          sceneIndex: ctx.scene.id,
          start_seconds: ctx.scene.start_seconds,
          end_seconds: ctx.scene.end_seconds,
          videoId: ctx.createVideoAsset.videoId,
        }))
        .build();

      expect(result.StartAt).toBe('FilterOutput');

      const state = result.States['FilterOutput'] as Record<string, unknown>;
      expect(state['Type']).toBe('Pass');
      expect(state['ResultPath']).toBe('$.filterOutput');
      expect(state['End']).toBe(true);
      expect(state).not.toHaveProperty('Resource');

      expect(state['Parameters']).toEqual({
        'sceneIndex.$': '$.scene.id',
        'start_seconds.$': '$.scene.start_seconds',
        'end_seconds.$': '$.scene.end_seconds',
        'videoId.$': '$.createVideoAsset.videoId',
      });
    });

    it('should support static values in pass parameters', () => {
      type Ctx = { scene: { id: string } };

      const result = new SequenceBuilder<Ctx>()
        .pass('addDefaults', (ctx) => ({
          sceneId: ctx.scene.id,
          isProcessed: true,
          version: 1,
        }))
        .build();

      const state = result.States['AddDefaults'] as Record<string, unknown>;
      expect(state['Parameters']).toEqual({
        'sceneId.$': '$.scene.id',
        isProcessed: true,
        version: 1,
      });
    });

    it('should wire pass between other states', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
        )
        .pass('reshape', (ctx) => ({
          fileId: ctx.loadFileUpload.fileUpload.id,
        }))
        .build();

      const task = result.States['LoadFileUpload'] as Record<string, unknown>;
      expect(task['Next']).toBe('Reshape');

      const pass = result.States['Reshape'] as Record<string, unknown>;
      expect(pass['End']).toBe(true);
    });
  });

  describe('comment', () => {
    it('should include Comment when provided to build()', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
        )
        .build({ comment: 'Asset Extraction' });

      expect(result.Comment).toBe('Asset Extraction');
    });

    it('should omit Comment when not provided', () => {
      type Ctx = { bucket: string; key: string };

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
        )
        .build();

      expect(result).not.toHaveProperty('Comment');
    });
  });

  describe('function ARN', () => {
    it('should set FunctionName in Parameters', () => {
      type Ctx = { bucket: string; key: string };
      const arn = 'arn:aws:lambda:us-east-1:123:function:my-fn';

      const result = new SequenceBuilder<Ctx>()
        .task(
          'loadFileUpload',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: arn,
          },
          (ctx) => ({
            bucket: ctx.bucket,
            key: ctx.key,
          })
        )
        .build();

      const state = result.States['LoadFileUpload'] as Record<string, unknown>;
      const params = state['Parameters'] as Record<string, unknown>;
      expect(params['FunctionName']).toBe(arn);
    });
  });
});

// ── Full JSON output ─────────────────────────────────────────────────

describe('SequenceBuilder JSON output', () => {
  it('should produce the expected ASL for a three-state chain', () => {
    type Ctx = { bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .task(
        'loadFileUpload',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: '${load_file_upload_arn}',
          retry: DEFAULT_RETRY,
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        })
      )
      .task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: '${run_mediainfo_arn}',
          retry: THROTTLE_RETRY,
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        })
      )
      .task(
        'createVideo',
        {
          inputSchema: CreateVideoInput,
          outputSchema: CreateVideoOutput,
          functionArn: '${create_video_arn}',
        },
        (ctx) => ({
          fileUpload: ctx.loadFileUpload.fileUpload,
          mediaInfo: ctx.runMediaInfo.mediaInfo,
        })
      )
      .build();

    expect(result).toEqual({
      StartAt: 'LoadFileUpload',
      States: {
        LoadFileUpload: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          ResultPath: '$.loadFileUpload',
          ResultSelector: {
            'fileUpload.$': '$.Payload.fileUpload',
          },
          Parameters: {
            FunctionName: '${load_file_upload_arn}',
            Payload: {
              step: 'load-file-upload',
              'bucket.$': '$.bucket',
              'key.$': '$.key',
            },
          },
          Retry: DEFAULT_RETRY,
          Next: 'RunMediaInfo',
        },
        RunMediaInfo: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          ResultPath: '$.runMediaInfo',
          ResultSelector: {
            'mediaInfo.$': '$.Payload.mediaInfo',
            'assetType.$': '$.Payload.assetType',
          },
          Parameters: {
            FunctionName: '${run_mediainfo_arn}',
            Payload: {
              step: 'run-mediainfo',
              'bucket.$': '$.bucket',
              'key.$': '$.key',
            },
          },
          Retry: THROTTLE_RETRY,
          Next: 'CreateVideo',
        },
        CreateVideo: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          ResultPath: '$.createVideo',
          ResultSelector: {
            'video.$': '$.Payload.video',
            'width.$': '$.Payload.width',
            'height.$': '$.Payload.height',
          },
          Parameters: {
            FunctionName: '${create_video_arn}',
            Payload: {
              step: 'create-video-for-file',
              'fileUpload.$': '$.loadFileUpload.fileUpload',
              'mediaInfo.$': '$.runMediaInfo.mediaInfo',
            },
          },
          End: true,
        },
      },
    });
  });

  it('should produce the expected ASL for parallel + downstream task', () => {
    type Ctx = { bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .parallel('process', [
        new SequenceBuilder<Ctx>().task(
          'extractFrames',
          {
            inputSchema: ExtractFramesInput,
            outputSchema: ExtractFramesOutput,
            functionArn: '${extract_arn}',
          },
          (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
        ),
        new SequenceBuilder<Ctx>().task(
          'transcodePreview',
          {
            inputSchema: TranscodePreviewInput,
            outputSchema: TranscodePreviewOutput,
            functionArn: '${transcode_arn}',
          },
          (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
        ),
      ])
      .task(
        'finalize',
        {
          inputSchema: FinalizeInput,
          outputSchema: FinalizeOutput,
          functionArn: '${finalize_arn}',
        },
        (ctx) => ({
          width: ctx.process[0].extractFrames.width,
          previewStorageRef: ctx.process[1].transcodePreview.previewStorageRef,
        })
      )
      .build();

    expect(result).toEqual({
      StartAt: 'Process',
      States: {
        Process: {
          Type: 'Parallel',
          ResultPath: '$.process',
          Branches: [
            {
              StartAt: 'ExtractFrames',
              States: {
                ExtractFrames: {
                  Type: 'Task',
                  Resource: 'arn:aws:states:::lambda:invoke',
                  ResultPath: '$.extractFrames',
                  ResultSelector: {
                    'frameStorageRefs.$': '$.Payload.frameStorageRefs',
                    'width.$': '$.Payload.width',
                  },
                  Parameters: {
                    FunctionName: '${extract_arn}',
                    Payload: {
                      step: 'extract-frames',
                      'bucket.$': '$.bucket',
                      'key.$': '$.key',
                    },
                  },
                  End: true,
                },
              },
            },
            {
              StartAt: 'TranscodePreview',
              States: {
                TranscodePreview: {
                  Type: 'Task',
                  Resource: 'arn:aws:states:::lambda:invoke',
                  ResultPath: '$.transcodePreview',
                  ResultSelector: {
                    'previewStorageRef.$': '$.Payload.previewStorageRef',
                  },
                  Parameters: {
                    FunctionName: '${transcode_arn}',
                    Payload: {
                      step: 'transcode-preview',
                      'bucket.$': '$.bucket',
                      'key.$': '$.key',
                    },
                  },
                  End: true,
                },
              },
            },
          ],
          Next: 'Finalize',
        },
        Finalize: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          ResultPath: '$.finalize',
          ResultSelector: {
            'assetId.$': '$.Payload.assetId',
          },
          Parameters: {
            FunctionName: '${finalize_arn}',
            Payload: {
              step: 'finalize',
              'width.$': '$.process[0].extractFrames.width',
              'previewStorageRef.$':
                '$.process[1].transcodePreview.previewStorageRef',
            },
          },
          End: true,
        },
      },
    });
  });
});

// ── Type-level tests ────────────────────────────────────────────────

describe('SequenceBuilder type safety', () => {
  it('should accumulate context across sequential tasks', () => {
    type Ctx = { bucket: string; key: string };

    const builder = new SequenceBuilder<Ctx>()
      .task(
        'loadFileUpload',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        })
      )
      .task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        })
      );

    expect(builder).toBeDefined();

    // After two tasks, the builder's context should include both outputs
    type ResultCtx = typeof builder extends SequenceBuilder<infer C>
      ? C
      : never;

    // Original context fields
    expectTypeOf<ResultCtx>().toHaveProperty('bucket');
    expectTypeOf<ResultCtx>().toHaveProperty('key');

    // First task's output
    expectTypeOf<ResultCtx>().toHaveProperty('loadFileUpload');
    expectTypeOf<ResultCtx['loadFileUpload']>().toHaveProperty('fileUpload');

    // Second task's output
    expectTypeOf<ResultCtx>().toHaveProperty('runMediaInfo');
    expectTypeOf<ResultCtx['runMediaInfo']>().toHaveProperty('mediaInfo');
    expectTypeOf<ResultCtx['runMediaInfo']>().toHaveProperty('assetType');
  });

  it('should allow referencing upstream output in downstream payload', () => {
    type Ctx = { bucket: string; key: string };

    // This test validates that the payload callback for createVideo
    // can access ctx.loadFileUpload and ctx.runMediaInfo from earlier tasks.
    // If the types are wrong, this would fail to compile.
    const builder = new SequenceBuilder<Ctx>()
      .task(
        'loadFileUpload',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        })
      )
      .task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        })
      )
      .task(
        'createVideo',
        {
          inputSchema: CreateVideoInput,
          outputSchema: CreateVideoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          // These refs are type-checked:
          // ctx.loadFileUpload.fileUpload is Ref<{id, organizationId, filename}>
          // ctx.runMediaInfo.mediaInfo is Ref<{width, height, duration}>
          fileUpload: ctx.loadFileUpload.fileUpload,
          mediaInfo: ctx.runMediaInfo.mediaInfo,
        })
      );

    expect(builder).toBeDefined();
  });

  it('should allow Proxied refs where Ref<T> is expected in TypedPayloadMapping', () => {
    type Ctx = {
      bucket: string;
      loadFileUpload: {
        fileUpload: {
          id: string;
          organizationId: string;
          filename: string;
        };
      };
      runMediaInfo: {
        mediaInfo: {
          width: number;
          height: number;
          duration: number;
        };
      };
    };

    type Mapping = TypedPayloadMapping<typeof CreateVideoInput>;

    // Proxied nested object refs should satisfy the field type
    type FileUploadRef = Proxied<Ctx>['loadFileUpload']['fileUpload'];
    expectTypeOf<FileUploadRef>().toExtend<Mapping['fileUpload']>();

    type MediaInfoRef = Proxied<Ctx>['runMediaInfo']['mediaInfo'];
    expectTypeOf<MediaInfoRef>().toExtend<Mapping['mediaInfo']>();
  });

  it('should reject mismatched ref types in payload', () => {
    type Mapping = TypedPayloadMapping<typeof CreateVideoInput>;

    // Ref<string> should NOT satisfy a field expecting an object
    expectTypeOf<Ref<string>>().not.toExtend<Mapping['fileUpload']>();

    // Ref<number> should NOT satisfy a field expecting an object
    expectTypeOf<Ref<number>>().not.toExtend<Mapping['mediaInfo']>();
  });

  it('should type parallel output as a tuple of branch deltas', () => {
    type Ctx = { bucket: string; key: string };

    const builder = new SequenceBuilder<Ctx>().parallel('process', [
      new SequenceBuilder<Ctx>().task(
        'extractFrames',
        {
          inputSchema: ExtractFramesInput,
          outputSchema: ExtractFramesOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
      ),
      new SequenceBuilder<Ctx>().task(
        'transcodePreview',
        {
          inputSchema: TranscodePreviewInput,
          outputSchema: TranscodePreviewOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
      ),
    ]);

    expect(builder).toBeDefined();

    type ResultCtx = typeof builder extends SequenceBuilder<infer C>
      ? C
      : never;

    // Original context preserved
    expectTypeOf<ResultCtx>().toHaveProperty('bucket');

    // Parallel result is a tuple
    expectTypeOf<ResultCtx>().toHaveProperty('process');

    // Branch 0 delta has extractFrames
    expectTypeOf<ResultCtx['process'][0]>().toHaveProperty('extractFrames');
    expectTypeOf<ResultCtx['process'][0]['extractFrames']>().toHaveProperty(
      'width'
    );

    // Branch 1 delta has transcodePreview
    expectTypeOf<ResultCtx['process'][1]>().toHaveProperty('transcodePreview');
    expectTypeOf<ResultCtx['process'][1]['transcodePreview']>().toHaveProperty(
      'previewStorageRef'
    );
  });

  it('should allow downstream task to reference parallel branch results', () => {
    type Ctx = { bucket: string; key: string };

    // This compiles only if ctx.process[0].extractFrames.width is Ref<number>
    // and ctx.process[1].transcodePreview.previewStorageRef is Ref<StorageRef>
    const builder = new SequenceBuilder<Ctx>()
      .parallel('process', [
        new SequenceBuilder<Ctx>().task(
          'extractFrames',
          {
            inputSchema: ExtractFramesInput,
            outputSchema: ExtractFramesOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
        ),
        new SequenceBuilder<Ctx>().task(
          'transcodePreview',
          {
            inputSchema: TranscodePreviewInput,
            outputSchema: TranscodePreviewOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
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
          width: ctx.process[0].extractFrames.width,
          previewStorageRef: ctx.process[1].transcodePreview.previewStorageRef,
        })
      );

    expect(builder).toBeDefined();
  });

  it('should accumulate pass output into context', () => {
    type Ctx = {
      scene: { id: string; start_seconds: number };
      createVideoAsset: { videoId: string };
    };

    const builder = new SequenceBuilder<Ctx>().pass('filterOutput', (ctx) => ({
      sceneIndex: ctx.scene.id,
      videoId: ctx.createVideoAsset.videoId,
      version: 1,
    }));

    expect(builder).toBeDefined();

    type ResultCtx = typeof builder extends SequenceBuilder<infer C>
      ? C
      : never;

    expectTypeOf<ResultCtx>().toHaveProperty('filterOutput');
    // Ref fields are unwrapped to their underlying types
    expectTypeOf<
      ResultCtx['filterOutput']['sceneIndex']
    >().toEqualTypeOf<string>();
    expectTypeOf<
      ResultCtx['filterOutput']['videoId']
    >().toEqualTypeOf<string>();
    // Static values keep their type
    expectTypeOf<
      ResultCtx['filterOutput']['version']
    >().toEqualTypeOf<number>();
  });
});

// ── Intrinsic functions ─────────────────────────────────────────────

describe('intrinsic functions', () => {
  it('should generate States.Format expression', () => {
    const item = createMapItemProxy<{ id: string }>();

    const expr = statesFormat('scene_{}/frame', item.value.id);
    expect(getExpression(expr)).toBe(
      "States.Format('scene_{}/frame', $$.Map.Item.Value.id)"
    );
  });

  it('should generate correct path for $$ references', () => {
    const item = createMapItemProxy<{ id: string; name: string }>();
    expect(pathOf(item.value)).toBe('$$.Map.Item.Value');
    expect(pathOf(item.value.id)).toBe('$$.Map.Item.Value.id');
    expect(pathOf(item.index)).toBe('$$.Map.Item.Index');
  });
});

// ── task() discriminator ────────────────────────────────────────────

describe('task discriminator field', () => {
  const TaskInput = z.object({
    task: z.literal('extract-frames'),
    resolution: z.number(),
    inputStorageRef: z.object({ bucket: z.string(), key: z.string() }),
  });

  const TaskOutput = z.object({
    frameStorageRefs: z.array(
      z.object({ bucket: z.string(), key: z.string() })
    ),
    width: z.number(),
  });

  it('should auto-fill task literal instead of step', () => {
    type Ctx = {
      inputStorageRef: { bucket: string; key: string };
    };

    const result = new SequenceBuilder<Ctx>()
      .task(
        'extractFrames',
        {
          inputSchema: TaskInput,
          outputSchema: TaskOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          resolution: 640,
          inputStorageRef: ctx.inputStorageRef,
        })
      )
      .build();

    const state = result.States['ExtractFrames'] as Record<string, unknown>;
    const params = state['Parameters'] as Record<string, unknown>;
    const payload = params['Payload'] as Record<string, unknown>;

    expect(payload['task']).toBe('extract-frames');
    expect(payload).not.toHaveProperty('step');
    expect(payload['resolution']).toBe(640);
    expect(payload['inputStorageRef.$']).toBe('$.inputStorageRef');
  });
});

// ── task() custom resultSelector ────────────────────────────────────

describe('task custom resultSelector', () => {
  const TranscodeInput = z.object({
    task: z.literal('transcode-video'),
    resolution: z.number(),
    inputStorageRef: z.object({ bucket: z.string(), key: z.string() }),
  });

  const TranscodeOutput = z.object({
    storageRef: z.object({ bucket: z.string(), key: z.string() }),
    width: z.number(),
    height: z.number(),
  });

  it('should use custom resultSelector when provided', () => {
    type Ctx = {
      inputStorageRef: { bucket: string; key: string };
    };

    const result = new SequenceBuilder<Ctx>()
      .task(
        'transcode',
        {
          inputSchema: TranscodeInput,
          outputSchema: TranscodeOutput,
          functionArn: LAMBDA_ARN,
          resultSelector: {
            'storageRef.$': '$.Payload.outputStorageRef',
            'width.$': '$.Payload.width',
            'height.$': '$.Payload.height',
          },
        },
        (ctx) => ({
          resolution: 640,
          inputStorageRef: ctx.inputStorageRef,
        })
      )
      .build();

    const state = result.States['Transcode'] as Record<string, unknown>;
    expect(state['ResultSelector']).toEqual({
      'storageRef.$': '$.Payload.outputStorageRef',
      'width.$': '$.Payload.width',
      'height.$': '$.Payload.height',
    });
  });
});

// ── pass() with resultPath: null ────────────────────────────────────

describe('pass with resultPath: null', () => {
  it('should omit ResultPath when resultPath is null', () => {
    type Ctx = {
      scene: { id: string; start_seconds: number; end_seconds: number };
      createVideoAsset: { videoId: string };
    };

    const result = new SequenceBuilder<Ctx>()
      .pass(
        'filterOutput',
        (ctx) => ({
          sceneIndex: ctx.scene.id,
          start_seconds: ctx.scene.start_seconds,
          end_seconds: ctx.scene.end_seconds,
          videoId: ctx.createVideoAsset.videoId,
        }),
        { resultPath: null }
      )
      .build();

    const state = result.States['FilterOutput'] as Record<string, unknown>;
    expect(state['Type']).toBe('Pass');
    expect(state).not.toHaveProperty('ResultPath');
    expect(state['Parameters']).toEqual({
      'sceneIndex.$': '$.scene.id',
      'start_seconds.$': '$.scene.start_seconds',
      'end_seconds.$': '$.scene.end_seconds',
      'videoId.$': '$.createVideoAsset.videoId',
    });
  });

  it('should include ResultPath when options not provided', () => {
    type Ctx = { scene: { id: string } };

    const result = new SequenceBuilder<Ctx>()
      .pass('filterOutput', (ctx) => ({
        sceneIndex: ctx.scene.id,
      }))
      .build();

    const state = result.States['FilterOutput'] as Record<string, unknown>;
    expect(state['ResultPath']).toBe('$.filterOutput');
  });
});

// ── map() ───────────────────────────────────────────────────────────

describe('map', () => {
  const ProcessInput = z.object({
    step: z.literal('process-item'),
    name: z.string(),
  });

  const ProcessOutput = z.object({
    result: z.string(),
  });

  it('should produce a Map state with ItemProcessor', () => {
    type Ctx = {
      items: { id: string; name: string }[];
      bucket: string;
    };

    const processor = new SequenceBuilder<{
      name: string;
      itemIndex: number;
      bucket: string;
    }>()
      .task(
        'processItem',
        {
          inputSchema: ProcessInput,
          outputSchema: ProcessOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({ name: ctx.name })
      )
      .build();

    const result = new SequenceBuilder<Ctx>()
      .map<'processAll', { id: string; name: string }>('processAll', {
        itemsPath: '$.items',
        maxConcurrency: 3,
        itemSelector: (item, ctx) => ({
          name: item.value.name,
          itemIndex: item.index,
          bucket: ctx.bucket,
        }),
        processor,
      })
      .build();

    expect(result.StartAt).toBe('ProcessAll');

    const state = result.States['ProcessAll'] as Record<string, unknown>;
    expect(state['Type']).toBe('Map');
    expect(state['ItemsPath']).toBe('$.items');
    expect(state['MaxConcurrency']).toBe(3);
    expect(state['ResultPath']).toBe('$.processAll');

    expect(state['ItemSelector']).toEqual({
      'name.$': '$$.Map.Item.Value.name',
      'itemIndex.$': '$$.Map.Item.Index',
      'bucket.$': '$.bucket',
    });

    const itemProcessor = state['ItemProcessor'] as Record<string, unknown>;
    expect(itemProcessor['ProcessorConfig']).toEqual({ Mode: 'INLINE' });
    expect(itemProcessor['StartAt']).toBe('ProcessItem');
    expect(itemProcessor['States']).toBeDefined();
  });

  it('should support intrinsic functions in itemSelector', () => {
    type Ctx = {
      items: { id: string }[];
    };

    const processor = new SequenceBuilder<{ prefix: string }>()
      .pass('identity', (ctx) => ({ prefix: ctx.prefix }))
      .build();

    const result = new SequenceBuilder<Ctx>()
      .map<'processAll', { id: string }>('processAll', {
        itemsPath: '$.items',
        itemSelector: (item) => ({
          prefix: statesFormat('item_{}/output', item.value.id),
        }),
        processor,
      })
      .build();

    const state = result.States['ProcessAll'] as Record<string, unknown>;
    const selector = state['ItemSelector'] as Record<string, unknown>;
    expect(selector['prefix.$']).toBe(
      "States.Format('item_{}/output', $$.Map.Item.Value.id)"
    );
  });

  it('should wire Map followed by another state', () => {
    type Ctx = {
      items: { id: string }[];
      bucket: string;
      key: string;
    };

    const processor = new SequenceBuilder<{ bucket: string }>()
      .pass('identity', (ctx) => ({ bucket: ctx.bucket }))
      .build();

    const result = new SequenceBuilder<Ctx>()
      .map<'processAll', { id: string }>('processAll', {
        itemsPath: '$.items',
        itemSelector: (_, ctx) => ({
          bucket: ctx.bucket,
        }),
        processor,
      })
      .task(
        'finalize',
        {
          inputSchema: z.object({
            step: z.literal('finalize'),
            bucket: z.string(),
          }),
          outputSchema: z.object({ done: z.boolean() }),
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          bucket: ctx.bucket,
        })
      )
      .build();

    const mapState = result.States['ProcessAll'] as Record<string, unknown>;
    expect(mapState['Next']).toBe('Finalize');
    expect(mapState).not.toHaveProperty('End');

    const finalizeState = result.States['Finalize'] as Record<string, unknown>;
    expect(finalizeState['End']).toBe(true);
  });

  it('should omit MaxConcurrency when not specified', () => {
    type Ctx = { items: { id: string }[] };

    const processor = new SequenceBuilder<Record<string, never>>()
      .pass('noop', () => ({ ok: true }))
      .build();

    const result = new SequenceBuilder<Ctx>()
      .map<'processAll', { id: string }>('processAll', {
        itemsPath: '$.items',
        itemSelector: () => ({}),
        processor,
      })
      .build();

    const state = result.States['ProcessAll'] as Record<string, unknown>;
    expect(state).not.toHaveProperty('MaxConcurrency');
  });
});

// ── pipe() ──────────────────────────────────────────────────────────

describe('pipe', () => {
  it('should apply a reusable task function in the chain', () => {
    type Ctx = { bucket: string; key: string };

    const addRunMediaInfo = <C extends { bucket: string; key: string }>(
      b: SequenceBuilder<C>
    ) =>
      b.task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        })
      );

    const result = new SequenceBuilder<Ctx>()
      .task(
        'loadFileUpload',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        })
      )
      .pipe(addRunMediaInfo)
      .build();

    expect(result.StartAt).toBe('LoadFileUpload');
    expect(Object.keys(result.States)).toEqual([
      'LoadFileUpload',
      'RunMediaInfo',
    ]);

    const first = result.States['LoadFileUpload'] as Record<string, unknown>;
    expect(first['Next']).toBe('RunMediaInfo');

    const second = result.States['RunMediaInfo'] as Record<string, unknown>;
    expect(second['End']).toBe(true);
  });

  it('should preserve context type through pipe for downstream tasks', () => {
    type Ctx = { bucket: string; key: string };

    const addLoadFileUpload = <C extends { bucket: string; key: string }>(
      b: SequenceBuilder<C>
    ) =>
      b.task(
        'loadFileUpload',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          bucket: ctx.bucket,
          key: ctx.key,
        })
      );

    const builder = new SequenceBuilder<Ctx>().pipe(addLoadFileUpload).task(
      'createVideo',
      {
        inputSchema: CreateVideoInput,
        outputSchema: CreateVideoOutput,
        functionArn: LAMBDA_ARN,
      },
      (ctx) => ({
        // This proves the piped task's output is in context
        fileUpload: ctx.loadFileUpload.fileUpload,
        mediaInfo: { width: 1920, height: 1080, duration: 60 },
      })
    );

    expect(builder).toBeDefined();

    type ResultCtx = typeof builder extends SequenceBuilder<infer C>
      ? C
      : never;

    expectTypeOf<ResultCtx>().toHaveProperty('loadFileUpload');
    expectTypeOf<ResultCtx>().toHaveProperty('createVideo');
  });

  it('should support chaining multiple pipes', () => {
    type Ctx = { bucket: string; key: string };

    const addLoad = <C extends { bucket: string; key: string }>(
      b: SequenceBuilder<C>
    ) =>
      b.task(
        'loadFileUpload',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
      );

    const addMediaInfo = <C extends { bucket: string; key: string }>(
      b: SequenceBuilder<C>
    ) =>
      b.task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
      );

    const result = new SequenceBuilder<Ctx>()
      .pipe(addLoad)
      .pipe(addMediaInfo)
      .build();

    expect(Object.keys(result.States)).toEqual([
      'LoadFileUpload',
      'RunMediaInfo',
    ]);
  });
});

// ── customTask() ────────────────────────────────────────────────────

describe('customTask', () => {
  it('should produce a Task state with custom resource', () => {
    type Ctx = {
      parentVideoId: string;
      extractScenes: unknown[];
      parentVideoStorage: { bucket: string; key: string };
    };

    const result = new SequenceBuilder<Ctx>()
      .customTask('transcode', {
        resource: 'arn:aws:states:::batch:submitJob',
        parameters: (ctx) => ({
          JobDefinition: '${job_definition_arn}',
          JobQueue: '${job_queue_arn}',
          JobName: statesFormat('Transcode-Extraction-{}', ctx.parentVideoId),
          ContainerOverrides: {
            Environment: [
              {
                Name: 'SCENES',
                Value: statesJsonToString(ctx.extractScenes),
              },
              {
                Name: 'PARENT_VIDEO_STORAGE',
                Value: statesJsonToString(ctx.parentVideoStorage),
              },
            ],
          },
        }),
        resultPath: '$.transcodeJob',
      })
      .build();

    expect(result.StartAt).toBe('Transcode');

    const state = result.States['Transcode'] as Record<string, unknown>;
    expect(state['Type']).toBe('Task');
    expect(state['Resource']).toBe('arn:aws:states:::batch:submitJob');
    expect(state['ResultPath']).toBe('$.transcodeJob');
    expect(state['End']).toBe(true);

    const params = state['Parameters'] as Record<string, unknown>;
    expect(params['JobDefinition']).toBe('${job_definition_arn}');
    expect(params['JobQueue']).toBe('${job_queue_arn}');
    expect(params['JobName.$']).toBe(
      "States.Format('Transcode-Extraction-{}', $.parentVideoId)"
    );

    const overrides = params['ContainerOverrides'] as Record<string, unknown>;
    const env = overrides['Environment'] as Record<string, unknown>[];
    expect(env).toHaveLength(2);
    expect(env[0]['Name']).toBe('SCENES');
    expect(env[0]['Value.$']).toBe('States.JsonToString($.extractScenes)');
    expect(env[1]['Name']).toBe('PARENT_VIDEO_STORAGE');
    expect(env[1]['Value.$']).toBe('States.JsonToString($.parentVideoStorage)');
  });

  it('should omit ResultPath when not provided', () => {
    type Ctx = { data: string };

    const result = new SequenceBuilder<Ctx>()
      .customTask('notify', {
        resource: 'arn:aws:states:::sns:publish',
        parameters: (ctx) => ({
          Message: ctx.data,
        }),
      })
      .build();

    const state = result.States['Notify'] as Record<string, unknown>;
    expect(state).not.toHaveProperty('ResultPath');
  });
});

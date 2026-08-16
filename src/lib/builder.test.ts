import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_RETRY,
  SequenceBuilder,
  THROTTLE_RETRY,
  type InferContext,
  type RetryConfig,
} from './builder.js';
import { serializeCondition } from './choice.js';
import {
  getExpression,
  statesArray,
  statesFormat,
  statesJsonToString,
  statesMathAdd,
} from './intrinsic.js';
import {
  createMapItemProxy,
  createProxy,
  pathOf,
  type MapItemRef,
} from './proxy.js';
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
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        )
        .task(
          'runMediaInfo',
          {
            inputSchema: RunMediaInfoInput,
            outputSchema: RunMediaInfoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'run-mediainfo' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        )
        .task(
          'runMediaInfo',
          {
            inputSchema: RunMediaInfoInput,
            outputSchema: RunMediaInfoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'run-mediainfo' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        )
        .task(
          'createVideo',
          {
            inputSchema: CreateVideoInput,
            outputSchema: CreateVideoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'create-video-for-file' as const,
            fileUpload: ctx.loadFileUpload.fileUpload,
            mediaInfo: ctx.runMediaInfo.mediaInfo,
          }),
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
    it('should include step literal from the payload callback', () => {
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
            step: 'run-mediainfo' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
            step: 'transcribe-video' as const,
            videoId: ctx.videoId,
            audioStorageRef: null,
          }),
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
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        )
        .task(
          'runMediaInfo',
          {
            inputSchema: RunMediaInfoInput,
            outputSchema: RunMediaInfoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'run-mediainfo' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        )
        .task(
          'createVideo',
          {
            inputSchema: CreateVideoInput,
            outputSchema: CreateVideoOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'create-video-for-file' as const,
            fileUpload: ctx.loadFileUpload.fileUpload,
            mediaInfo: ctx.runMediaInfo.mediaInfo,
          }),
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
            step: 'run-mediainfo' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
            (ctx) => ({
              step: 'extract-frames' as const,
              bucket: ctx.bucket,
              key: ctx.key,
            }),
          ),
          new SequenceBuilder<Ctx>().task(
            'transcodePreview',
            {
              inputSchema: TranscodePreviewInput,
              outputSchema: TranscodePreviewOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({
              step: 'transcode-preview' as const,
              bucket: ctx.bucket,
              key: ctx.key,
            }),
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
            (ctx) => ({
              step: 'extract-frames' as const,
              bucket: ctx.bucket,
              key: ctx.key,
            }),
          ),
          new SequenceBuilder<Ctx>().task(
            'transcodePreview',
            {
              inputSchema: TranscodePreviewInput,
              outputSchema: TranscodePreviewOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({
              step: 'transcode-preview' as const,
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
            step: 'finalize' as const,
            width: ctx.process[0].extractFrames.width,
            previewStorageRef:
              ctx.process[1].transcodePreview.previewStorageRef,
          }),
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
              (ctx) => ({
                step: 'extract-frames' as const,
                bucket: ctx.bucket,
                key: ctx.key,
              }),
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
                  step: 'generate-embedding' as const,
                  frameStorageRefs: ctx.extractFrames.frameStorageRefs,
                }),
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
            (ctx) => ({
              step: 'transcode-preview' as const,
              bucket: ctx.bucket,
              key: ctx.key,
            }),
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
          (ctx) => ({
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
          (ctx) => ({
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
          (ctx) => ({
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
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
          step: 'load-file-upload' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
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
          step: 'run-mediainfo' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .task(
        'createVideo',
        {
          inputSchema: CreateVideoInput,
          outputSchema: CreateVideoOutput,
          functionArn: '${create_video_arn}',
        },
        (ctx) => ({
          step: 'create-video-for-file' as const,
          fileUpload: ctx.loadFileUpload.fileUpload,
          mediaInfo: ctx.runMediaInfo.mediaInfo,
        }),
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
              step: 'load-file-upload' as const,
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
              step: 'run-mediainfo' as const,
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
              step: 'create-video-for-file' as const,
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
          (ctx) => ({
            step: 'extract-frames' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        ),
        new SequenceBuilder<Ctx>().task(
          'transcodePreview',
          {
            inputSchema: TranscodePreviewInput,
            outputSchema: TranscodePreviewOutput,
            functionArn: '${transcode_arn}',
          },
          (ctx) => ({
            step: 'transcode-preview' as const,
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
          functionArn: '${finalize_arn}',
        },
        (ctx) => ({
          step: 'finalize' as const,
          width: ctx.process[0].extractFrames.width,
          previewStorageRef: ctx.process[1].transcodePreview.previewStorageRef,
        }),
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
              step: 'finalize' as const,
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
          step: 'load-file-upload' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'run-mediainfo' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      );

    expect(builder).toBeDefined();

    // After two tasks, the builder's context should include both outputs
    type ResultCtx =
      typeof builder extends SequenceBuilder<infer C> ? C : never;

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
          step: 'load-file-upload' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'run-mediainfo' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .task(
        'createVideo',
        {
          inputSchema: CreateVideoInput,
          outputSchema: CreateVideoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'create-video-for-file' as const,
          fileUpload: ctx.loadFileUpload.fileUpload,
          mediaInfo: ctx.runMediaInfo.mediaInfo,
        }),
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
        (ctx) => ({
          step: 'extract-frames' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      ),
      new SequenceBuilder<Ctx>().task(
        'transcodePreview',
        {
          inputSchema: TranscodePreviewInput,
          outputSchema: TranscodePreviewOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'transcode-preview' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      ),
    ]);

    expect(builder).toBeDefined();

    type ResultCtx =
      typeof builder extends SequenceBuilder<infer C> ? C : never;

    // Original context preserved
    expectTypeOf<ResultCtx>().toHaveProperty('bucket');

    // Parallel result is a tuple
    expectTypeOf<ResultCtx>().toHaveProperty('process');

    // Branch 0 delta has extractFrames
    expectTypeOf<ResultCtx['process'][0]>().toHaveProperty('extractFrames');
    expectTypeOf<ResultCtx['process'][0]['extractFrames']>().toHaveProperty(
      'width',
    );

    // Branch 1 delta has transcodePreview
    expectTypeOf<ResultCtx['process'][1]>().toHaveProperty('transcodePreview');
    expectTypeOf<ResultCtx['process'][1]['transcodePreview']>().toHaveProperty(
      'previewStorageRef',
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
          (ctx) => ({
            step: 'extract-frames' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        ),
        new SequenceBuilder<Ctx>().task(
          'transcodePreview',
          {
            inputSchema: TranscodePreviewInput,
            outputSchema: TranscodePreviewOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'transcode-preview' as const,
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
          step: 'finalize' as const,
          width: ctx.process[0].extractFrames.width,
          previewStorageRef: ctx.process[1].transcodePreview.previewStorageRef,
        }),
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

    type ResultCtx =
      typeof builder extends SequenceBuilder<infer C> ? C : never;

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
      "States.Format('scene_{}/frame', $$.Map.Item.Value.id)",
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
      z.object({ bucket: z.string(), key: z.string() }),
    ),
    width: z.number(),
  });

  it('should include task literal from the payload callback', () => {
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
          task: 'extract-frames' as const,
          resolution: 640,
          inputStorageRef: ctx.inputStorageRef,
        }),
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

  // outputSchema describes the actual Lambda response
  const TranscodeOutput = z.object({
    outputStorageRef: z.object({ bucket: z.string(), key: z.string() }),
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
          resultSelector: (output) => ({
            storageRef: output.outputStorageRef,
            width: output.width,
            height: output.height,
          }),
        },
        (ctx) => ({
          task: 'transcode-video' as const,
          resolution: 640,
          inputStorageRef: ctx.inputStorageRef,
        }),
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

// ── task() with resultPath: null ─────────────────────────────────────

describe('task with resultPath: null', () => {
  const TranscodeInput = z.object({
    task: z.literal('transcode-video'),
    resolution: z.number(),
    inputStorageRef: z.object({ bucket: z.string(), key: z.string() }),
  });

  const TranscodeOutput = z.object({
    outputStorageRef: z.object({ bucket: z.string(), key: z.string() }),
    width: z.number(),
    height: z.number(),
  });

  it('should omit ResultPath when resultPath is null', () => {
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
          resultPath: null,
        },
        (ctx) => ({
          task: 'transcode-video' as const,
          resolution: 640,
          inputStorageRef: ctx.inputStorageRef,
        }),
      )
      .build();

    const state = result.States['Transcode'] as Record<string, unknown>;
    expect(state['Type']).toBe('Task');
    expect(state).not.toHaveProperty('ResultPath');
    expect(state['ResultSelector']).toEqual({
      'outputStorageRef.$': '$.Payload.outputStorageRef',
      'width.$': '$.Payload.width',
      'height.$': '$.Payload.height',
    });
  });

  it('should omit ResultPath with resultSelector + resultPath: null', () => {
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
          resultSelector: (output) => ({
            storageRef: output.outputStorageRef,
          }),
          resultPath: null,
        },
        (ctx) => ({
          task: 'transcode-video' as const,
          resolution: 640,
          inputStorageRef: ctx.inputStorageRef,
        }),
      )
      .build();

    const state = result.States['Transcode'] as Record<string, unknown>;
    expect(state['Type']).toBe('Task');
    expect(state).not.toHaveProperty('ResultPath');
    expect(state['ResultSelector']).toEqual({
      'storageRef.$': '$.Payload.outputStorageRef',
    });
  });

  it('should still include ResultPath when resultPath is not specified', () => {
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
        },
        (ctx) => ({
          task: 'transcode-video' as const,
          resolution: 640,
          inputStorageRef: ctx.inputStorageRef,
        }),
      )
      .build();

    const state = result.States['Transcode'] as Record<string, unknown>;
    expect(state['ResultPath']).toBe('$.transcode');
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
        { resultPath: null },
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

    const result = new SequenceBuilder<Ctx>()
      .map('processAll', {
        itemsPath: '$.items',
        maxConcurrency: 3,
        itemSelector: (
          item: MapItemRef<{ id: string; name: string }>,
          ctx,
        ) => ({
          name: item.value.name,
          itemIndex: item.index,
          bucket: ctx.bucket,
        }),
        processor: (b) =>
          b.task(
            'processItem',
            {
              inputSchema: ProcessInput,
              outputSchema: ProcessOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({ step: 'process-item' as const, name: ctx.name }),
          ),
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

    const result = new SequenceBuilder<Ctx>()
      .map('processAll', {
        itemsPath: '$.items',
        itemSelector: (item: MapItemRef<{ id: string }>) => ({
          prefix: statesFormat('item_{}/output', item.value.id),
        }),
        processor: (b) => b.pass('identity', (ctx) => ({ prefix: ctx.prefix })),
      })
      .build();

    const state = result.States['ProcessAll'] as Record<string, unknown>;
    const selector = state['ItemSelector'] as Record<string, unknown>;
    expect(selector['prefix.$']).toBe(
      "States.Format('item_{}/output', $$.Map.Item.Value.id)",
    );
  });

  it('should wire Map followed by another state', () => {
    type Ctx = {
      items: { id: string }[];
      bucket: string;
      key: string;
    };

    const result = new SequenceBuilder<Ctx>()
      .map('processAll', {
        itemsPath: '$.items',
        itemSelector: (_, ctx) => ({
          bucket: ctx.bucket,
        }),
        processor: (b) => b.pass('identity', (ctx) => ({ bucket: ctx.bucket })),
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
          step: 'finalize' as const,
          bucket: ctx.bucket,
        }),
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

    const result = new SequenceBuilder<Ctx>()
      .map('processAll', {
        itemsPath: '$.items',
        itemSelector: () => ({}),
        processor: (b) => b.pass('noop', () => ({ ok: true })),
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
      b: SequenceBuilder<C>,
    ) =>
      b.task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'run-mediainfo' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
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
          step: 'load-file-upload' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
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
      b: SequenceBuilder<C>,
    ) =>
      b.task(
        'loadFileUpload',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'load-file-upload' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      );

    const builder = new SequenceBuilder<Ctx>().pipe(addLoadFileUpload).task(
      'createVideo',
      {
        inputSchema: CreateVideoInput,
        outputSchema: CreateVideoOutput,
        functionArn: LAMBDA_ARN,
      },
      (ctx) => ({
        step: 'create-video-for-file' as const,
        // This proves the piped task's output is in context
        fileUpload: ctx.loadFileUpload.fileUpload,
        mediaInfo: { width: 1920, height: 1080, duration: 60 },
      }),
    );

    expect(builder).toBeDefined();

    type ResultCtx =
      typeof builder extends SequenceBuilder<infer C> ? C : never;

    expectTypeOf<ResultCtx>().toHaveProperty('loadFileUpload');
    expectTypeOf<ResultCtx>().toHaveProperty('createVideo');
  });

  it('should support chaining multiple pipes', () => {
    type Ctx = { bucket: string; key: string };

    const addLoad = <C extends { bucket: string; key: string }>(
      b: SequenceBuilder<C>,
    ) =>
      b.task(
        'loadFileUpload',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'load-file-upload' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      );

    const addMediaInfo = <C extends { bucket: string; key: string }>(
      b: SequenceBuilder<C>,
    ) =>
      b.task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'run-mediainfo' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
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
      "States.Format('Transcode-Extraction-{}', $.parentVideoId)",
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

// ── fail() ──────────────────────────────────────────────────────────

describe('fail', () => {
  it('should produce a Fail state with Error and Cause', () => {
    type Ctx = { bucket: string };

    const result = new SequenceBuilder<Ctx>()
      .fail('validationFailed', {
        error: 'ValidationError',
        cause: 'Input is invalid',
      })
      .build();

    expect(result.StartAt).toBe('ValidationFailed');
    const state = result.States['ValidationFailed'] as Record<string, unknown>;
    expect(state['Type']).toBe('Fail');
    expect(state['Error']).toBe('ValidationError');
    expect(state['Cause']).toBe('Input is invalid');
    expect(state).not.toHaveProperty('Next');
    expect(state).not.toHaveProperty('End');
  });

  it('should produce a Fail state as the only state', () => {
    const result = new SequenceBuilder<Record<string, never>>()
      .fail('abort', { error: 'Aborted' })
      .build();

    expect(result.StartAt).toBe('Abort');
    expect(Object.keys(result.States)).toEqual(['Abort']);
  });

  it('should support Fail with only Error', () => {
    const result = new SequenceBuilder<Record<string, never>>()
      .fail('errorOnly', { error: 'SomeError' })
      .build();

    const state = result.States['ErrorOnly'] as Record<string, unknown>;
    expect(state['Error']).toBe('SomeError');
    expect(state).not.toHaveProperty('Cause');
  });

  it('should support Fail with only Cause', () => {
    const result = new SequenceBuilder<Record<string, never>>()
      .fail('causeOnly', { cause: 'Something went wrong' })
      .build();

    const state = result.States['CauseOnly'] as Record<string, unknown>;
    expect(state['Cause']).toBe('Something went wrong');
    expect(state).not.toHaveProperty('Error');
  });
});

// ── choice() ────────────────────────────────────────────────────────

describe('choice', () => {
  it('should produce a Choice state with a condition and default fall-through', () => {
    type Ctx = { assetType: string; bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkType', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.assetType, stringEquals: 'video' },
            then: (b) =>
              b.task(
                'processVideo',
                {
                  inputSchema: RunMediaInfoInput,
                  outputSchema: RunMediaInfoOutput,
                  functionArn: LAMBDA_ARN,
                },
                (c) => ({
                  step: 'run-mediainfo' as const,
                  bucket: c.bucket,
                  key: c.key,
                }),
              ),
          },
        ],
      }))
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
        (ctx) => ({ step: 'finalize' as const, bucket: ctx.bucket }),
      )
      .build();

    const choice = result.States['CheckType'] as Record<string, unknown>;
    expect(choice['Type']).toBe('Choice');
    expect(choice).not.toHaveProperty('Next');
    expect(choice).not.toHaveProperty('End');

    const choices = choice['Choices'] as Record<string, unknown>[];
    expect(choices).toHaveLength(1);
    expect(choices[0]['Variable']).toBe('$.assetType');
    expect(choices[0]['StringEquals']).toBe('video');
    expect(choices[0]['Next']).toBe('ProcessVideo');

    // Default falls through to Finalize
    expect(choice['Default']).toBe('Finalize');

    // Branch state converges to Finalize
    const processVideo = result.States['ProcessVideo'] as Record<
      string,
      unknown
    >;
    expect(processVideo['Next']).toBe('Finalize');
    expect(processVideo).not.toHaveProperty('End');

    // Finalize is the last state
    const finalize = result.States['Finalize'] as Record<string, unknown>;
    expect(finalize['End']).toBe(true);
  });

  it('should support multiple conditions that all converge', () => {
    type Ctx = { assetType: string; bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkType', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.assetType, stringEquals: 'video' },
            then: (b) =>
              b.pass('videoPath', () => ({ type: 'video' as const })),
          },
          {
            when: { variable: ctx.assetType, stringEquals: 'image' },
            then: (b) =>
              b.pass('imagePath', () => ({ type: 'image' as const })),
          },
        ],
      }))
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
        (ctx) => ({ step: 'finalize' as const, bucket: ctx.bucket }),
      )
      .build();

    const choice = result.States['CheckType'] as Record<string, unknown>;
    const choices = choice['Choices'] as Record<string, unknown>[];
    expect(choices).toHaveLength(2);

    // Both branches converge to Finalize
    const videoPath = result.States['VideoPath'] as Record<string, unknown>;
    expect(videoPath['Next']).toBe('Finalize');

    const imagePath = result.States['ImagePath'] as Record<string, unknown>;
    expect(imagePath['Next']).toBe('Finalize');
  });

  it('should support an explicit default branch', () => {
    type Ctx = { assetType: string; bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkType', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.assetType, stringEquals: 'video' },
            then: (b) =>
              b.pass('videoPath', () => ({ type: 'video' as const })),
          },
        ],
        default: (b) =>
          b.pass('defaultPath', () => ({ type: 'other' as const })),
      }))
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
        (ctx) => ({ step: 'finalize' as const, bucket: ctx.bucket }),
      )
      .build();

    const choice = result.States['CheckType'] as Record<string, unknown>;
    expect(choice['Default']).toBe('DefaultPath');

    // Default branch converges
    const defaultPath = result.States['DefaultPath'] as Record<string, unknown>;
    expect(defaultPath['Next']).toBe('Finalize');
  });

  it('should handle choice as the last state (branches get End: true)', () => {
    type Ctx = { assetType: string };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkType', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.assetType, stringEquals: 'video' },
            then: (b) =>
              b.pass('videoPath', () => ({ type: 'video' as const })),
          },
        ],
        default: (b) =>
          b.pass('defaultPath', () => ({ type: 'other' as const })),
      }))
      .build();

    // Branch states keep End: true when choice is last
    const videoPath = result.States['VideoPath'] as Record<string, unknown>;
    expect(videoPath['End']).toBe(true);

    const defaultPath = result.States['DefaultPath'] as Record<string, unknown>;
    expect(defaultPath['End']).toBe(true);
  });

  it('should generate an end pass state when choice is last with no default', () => {
    type Ctx = { flag: boolean | null };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkFlag', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.flag, isNull: false },
            then: (b) => b.pass('doWork', () => ({ done: true as const })),
          },
        ],
      }))
      .build();

    // The conditional branch keeps End: true
    const doWork = result.States['DoWork'] as Record<string, unknown>;
    expect(doWork['End']).toBe(true);

    // An auto-generated pass end state is created for the default
    const endPass = result.States['CheckFlagEnd'] as Record<string, unknown>;
    expect(endPass).toBeDefined();
    expect(endPass['Type']).toBe('Pass');
    expect(endPass['End']).toBe(true);

    // Default points to the auto-generated end state
    const choice = result.States['CheckFlag'] as Record<string, unknown>;
    expect(choice['Default']).toBe('CheckFlagEnd');
  });

  it('should not rewire Fail states inside choice branches', () => {
    type Ctx = { assetType: string; bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkType', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.assetType, stringEquals: 'video' },
            then: (b) =>
              b.pass('videoPath', () => ({ type: 'video' as const })),
          },
        ],
        default: (b) =>
          b.fail('unknownType', {
            error: 'UnknownAssetType',
            cause: 'Not supported',
          }),
      }))
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
        (ctx) => ({ step: 'finalize' as const, bucket: ctx.bucket }),
      )
      .build();

    // Fail state is NOT rewired — stays terminal
    const failState = result.States['UnknownType'] as Record<string, unknown>;
    expect(failState['Type']).toBe('Fail');
    expect(failState).not.toHaveProperty('Next');
    expect(failState).not.toHaveProperty('End');

    // Non-fail branch converges
    const videoPath = result.States['VideoPath'] as Record<string, unknown>;
    expect(videoPath['Next']).toBe('Finalize');
  });

  it('should handle empty branch (points directly to convergence)', () => {
    type Ctx = { assetType: string; bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkType', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.assetType, stringEquals: 'video' },
            then: (b) =>
              b.pass('videoPath', () => ({ type: 'video' as const })),
          },
          {
            when: { variable: ctx.assetType, stringEquals: 'image' },
            // Empty branch — skip straight to next state
            then: (b) => b,
          },
        ],
      }))
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
        (ctx) => ({ step: 'finalize' as const, bucket: ctx.bucket }),
      )
      .build();

    const choice = result.States['CheckType'] as Record<string, unknown>;
    const choices = choice['Choices'] as Record<string, unknown>[];
    expect(choices[1]['Next']).toBe('Finalize');
  });

  it('should support nested choice (choice within a choice branch)', () => {
    type Ctx = { assetType: string; quality: string };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkType', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.assetType, stringEquals: 'video' },
            then: (b) =>
              b.choice('checkQuality', (c) => ({
                choices: [
                  {
                    when: { variable: c.quality, stringEquals: 'hd' },
                    then: (b2) =>
                      b2.pass('hdPath', () => ({ quality: 'hd' as const })),
                  },
                ],
                default: (b2) =>
                  b2.pass('sdPath', () => ({ quality: 'sd' as const })),
              })),
          },
        ],
        default: (b) => b.pass('otherPath', () => ({ type: 'other' as const })),
      }))
      .build();

    // Outer choice exists
    expect(result.States['CheckType']).toBeDefined();
    const outerChoice = result.States['CheckType'] as Record<string, unknown>;
    expect(outerChoice['Type']).toBe('Choice');

    // Inner choice exists
    expect(result.States['CheckQuality']).toBeDefined();
    const innerChoice = result.States['CheckQuality'] as Record<
      string,
      unknown
    >;
    expect(innerChoice['Type']).toBe('Choice');

    // Inner branch states exist
    expect(result.States['HdPath']).toBeDefined();
    expect(result.States['SdPath']).toBeDefined();
    expect(result.States['OtherPath']).toBeDefined();
  });

  it('should throw on duplicate state names across branches', () => {
    type Ctx = { flag: boolean };

    expect(() =>
      new SequenceBuilder<Ctx>()
        .choice('check', (ctx) => ({
          choices: [
            {
              when: { variable: ctx.flag, booleanEquals: true },
              then: (b) => b.pass('duplicate', () => ({ a: 1 })),
            },
            {
              when: { variable: ctx.flag, booleanEquals: false },
              then: (b) => b.pass('duplicate', () => ({ b: 2 })),
            },
          ],
        }))
        .task(
          'next',
          {
            inputSchema: z.object({
              step: z.literal('finalize'),
              bucket: z.string(),
            }),
            outputSchema: z.object({ done: z.boolean() }),
            functionArn: LAMBDA_ARN,
          },
          () => ({ step: 'finalize' as const, bucket: 'x' }),
        )
        .build(),
    ).toThrow('Duplicate state name "Duplicate"');
  });

  it('should support compound conditions (and/or/not)', () => {
    type Ctx = { assetType: string; size: number };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkCompound', (ctx) => ({
        choices: [
          {
            when: {
              and: [
                { variable: ctx.assetType, stringEquals: 'video' },
                { variable: ctx.size, numericGreaterThan: 1000 },
              ],
            },
            then: (b) =>
              b.pass('largeVideo', () => ({ matched: true as const })),
          },
          {
            when: {
              or: [
                { variable: ctx.assetType, stringEquals: 'image' },
                { variable: ctx.size, numericLessThan: 100 },
              ],
            },
            then: (b) =>
              b.pass('smallOrImage', () => ({ matched: true as const })),
          },
          {
            when: {
              not: { variable: ctx.assetType, stringEquals: 'audio' },
            },
            then: (b) => b.pass('notAudio', () => ({ matched: true as const })),
          },
        ],
        default: (b) => b.pass('fallback', () => ({ matched: false as const })),
      }))
      .build();

    const choice = result.States['CheckCompound'] as Record<string, unknown>;
    const choices = choice['Choices'] as Record<string, unknown>[];

    // And condition
    expect(choices[0]).toHaveProperty('And');
    const andRules = choices[0]['And'] as Record<string, unknown>[];
    expect(andRules).toHaveLength(2);
    expect(andRules[0]['Variable']).toBe('$.assetType');
    expect(andRules[0]['StringEquals']).toBe('video');
    expect(andRules[1]['Variable']).toBe('$.size');
    expect(andRules[1]['NumericGreaterThan']).toBe(1000);

    // Or condition
    expect(choices[1]).toHaveProperty('Or');

    // Not condition
    expect(choices[2]).toHaveProperty('Not');
    const notRule = choices[2]['Not'] as Record<string, unknown>;
    expect(notRule['Variable']).toBe('$.assetType');
    expect(notRule['StringEquals']).toBe('audio');
  });

  it('should support isPresent and isNull conditions', () => {
    type Ctx = { optionalField: string | null; data: unknown };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkPresence', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.optionalField, isPresent: true },
            then: (b) => b.pass('present', () => ({ found: true as const })),
          },
          {
            when: { variable: ctx.data, isNull: true },
            then: (b) => b.pass('nullData', () => ({ isNull: true as const })),
          },
        ],
        default: (b) => b.pass('fallback', () => ({ ok: true })),
      }))
      .build();

    const choice = result.States['CheckPresence'] as Record<string, unknown>;
    const choices = choice['Choices'] as Record<string, unknown>[];

    expect(choices[0]['Variable']).toBe('$.optionalField');
    expect(choices[0]['IsPresent']).toBe(true);

    expect(choices[1]['Variable']).toBe('$.data');
    expect(choices[1]['IsNull']).toBe(true);
  });

  it('should support string variable pass-through (raw JSONPath)', () => {
    type Ctx = { bucket: string };

    const result = new SequenceBuilder<Ctx>()
      .choice('checkRaw', () => ({
        choices: [
          {
            when: {
              variable: '$.some.deep.path',
              stringEquals: 'expected',
            },
            then: (b) => b.pass('matched', () => ({ ok: true })),
          },
        ],
        default: (b) => b.pass('fallback', () => ({ ok: false })),
      }))
      .build();

    const choice = result.States['CheckRaw'] as Record<string, unknown>;
    const choices = choice['Choices'] as Record<string, unknown>[];
    expect(choices[0]['Variable']).toBe('$.some.deep.path');
  });

  it('should produce correct full JSON snapshot', () => {
    type Ctx = { assetType: string; bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .task(
        'loadFile',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: '${load_arn}',
        },
        (ctx) => ({
          step: 'load-file-upload' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .choice('checkType', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.assetType, stringEquals: 'video' },
            then: (b) =>
              b.task(
                'processVideo',
                {
                  inputSchema: RunMediaInfoInput,
                  outputSchema: RunMediaInfoOutput,
                  functionArn: '${mediainfo_arn}',
                },
                (c) => ({
                  step: 'run-mediainfo' as const,
                  bucket: c.bucket,
                  key: c.key,
                }),
              ),
          },
        ],
        default: (b) =>
          b.fail('unsupportedType', {
            error: 'UnsupportedType',
            cause: 'Asset type not supported',
          }),
      }))
      .task(
        'finalize',
        {
          inputSchema: z.object({
            step: z.literal('finalize'),
            bucket: z.string(),
          }),
          outputSchema: z.object({ done: z.boolean() }),
          functionArn: '${finalize_arn}',
        },
        (ctx) => ({ step: 'finalize' as const, bucket: ctx.bucket }),
      )
      .build();

    expect(result).toEqual({
      StartAt: 'LoadFile',
      States: {
        LoadFile: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          ResultPath: '$.loadFile',
          ResultSelector: { 'fileUpload.$': '$.Payload.fileUpload' },
          Parameters: {
            FunctionName: '${load_arn}',
            Payload: {
              step: 'load-file-upload' as const,
              'bucket.$': '$.bucket',
              'key.$': '$.key',
            },
          },
          Next: 'CheckType',
        },
        CheckType: {
          Type: 'Choice',
          Choices: [
            {
              Variable: '$.assetType',
              StringEquals: 'video',
              Next: 'ProcessVideo',
            },
          ],
          Default: 'UnsupportedType',
        },
        ProcessVideo: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          ResultPath: '$.processVideo',
          ResultSelector: {
            'mediaInfo.$': '$.Payload.mediaInfo',
            'assetType.$': '$.Payload.assetType',
          },
          Parameters: {
            FunctionName: '${mediainfo_arn}',
            Payload: {
              step: 'run-mediainfo' as const,
              'bucket.$': '$.bucket',
              'key.$': '$.key',
            },
          },
          Next: 'Finalize',
        },
        UnsupportedType: {
          Type: 'Fail',
          Error: 'UnsupportedType',
          Cause: 'Asset type not supported',
        },
        Finalize: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          ResultPath: '$.finalize',
          ResultSelector: { 'done.$': '$.Payload.done' },
          Parameters: {
            FunctionName: '${finalize_arn}',
            Payload: {
              step: 'finalize' as const,
              'bucket.$': '$.bucket',
            },
          },
          End: true,
        },
      },
    });
  });
});

// ── serializeCondition() ────────────────────────────────────────────

describe('serializeCondition', () => {
  it('should serialize stringEquals', () => {
    const result = serializeCondition({
      variable: '$.type',
      stringEquals: 'video',
    });
    expect(result).toEqual({
      Variable: '$.type',
      StringEquals: 'video',
    });
  });

  it('should serialize numericEquals', () => {
    const result = serializeCondition({
      variable: '$.count',
      numericEquals: 42,
    });
    expect(result).toEqual({
      Variable: '$.count',
      NumericEquals: 42,
    });
  });

  it('should serialize numericGreaterThan', () => {
    const result = serializeCondition({
      variable: '$.size',
      numericGreaterThan: 1000,
    });
    expect(result).toEqual({
      Variable: '$.size',
      NumericGreaterThan: 1000,
    });
  });

  it('should serialize numericLessThan', () => {
    const result = serializeCondition({
      variable: '$.size',
      numericLessThan: 100,
    });
    expect(result).toEqual({
      Variable: '$.size',
      NumericLessThan: 100,
    });
  });

  it('should serialize booleanEquals', () => {
    const result = serializeCondition({
      variable: '$.isReady',
      booleanEquals: true,
    });
    expect(result).toEqual({
      Variable: '$.isReady',
      BooleanEquals: true,
    });
  });

  it('should serialize isPresent', () => {
    const result = serializeCondition({
      variable: '$.optionalField',
      isPresent: true,
    });
    expect(result).toEqual({
      Variable: '$.optionalField',
      IsPresent: true,
    });
  });

  it('should serialize isNull', () => {
    const result = serializeCondition({
      variable: '$.data',
      isNull: true,
    });
    expect(result).toEqual({
      Variable: '$.data',
      IsNull: true,
    });
  });

  it('should resolve Ref-based variable to JSONPath', () => {
    const proxy = createProxy<{ assetType: string }>();
    const result = serializeCondition({
      variable: proxy.assetType,
      stringEquals: 'video',
    });
    expect(result).toEqual({
      Variable: '$.assetType',
      StringEquals: 'video',
    });
  });

  it('should pass through string variable as-is', () => {
    const result = serializeCondition({
      variable: '$.deep.nested.path',
      stringEquals: 'value',
    });
    expect(result['Variable']).toBe('$.deep.nested.path');
  });

  it('should serialize nested and conditions', () => {
    const result = serializeCondition({
      and: [
        { variable: '$.type', stringEquals: 'video' },
        { variable: '$.size', numericGreaterThan: 100 },
      ],
    });
    expect(result).toEqual({
      And: [
        { Variable: '$.type', StringEquals: 'video' },
        { Variable: '$.size', NumericGreaterThan: 100 },
      ],
    });
  });

  it('should serialize nested or conditions', () => {
    const result = serializeCondition({
      or: [
        { variable: '$.type', stringEquals: 'image' },
        { variable: '$.size', numericLessThan: 50 },
      ],
    });
    expect(result).toEqual({
      Or: [
        { Variable: '$.type', StringEquals: 'image' },
        { Variable: '$.size', NumericLessThan: 50 },
      ],
    });
  });

  it('should serialize not condition', () => {
    const result = serializeCondition({
      not: { variable: '$.type', stringEquals: 'audio' },
    });
    expect(result).toEqual({
      Not: { Variable: '$.type', StringEquals: 'audio' },
    });
  });

  it('should serialize deeply nested compound conditions', () => {
    const result = serializeCondition({
      and: [
        {
          or: [
            { variable: '$.a', stringEquals: 'x' },
            { variable: '$.b', numericEquals: 1 },
          ],
        },
        { not: { variable: '$.c', booleanEquals: false } },
      ],
    });
    expect(result).toEqual({
      And: [
        {
          Or: [
            { Variable: '$.a', StringEquals: 'x' },
            { Variable: '$.b', NumericEquals: 1 },
          ],
        },
        { Not: { Variable: '$.c', BooleanEquals: false } },
      ],
    });
  });
});

// ── Type-level tests for choice/fail ────────────────────────────────

describe('choice/fail type safety', () => {
  it('should preserve context type after choice', () => {
    type Ctx = { assetType: string; bucket: string };

    const builder = new SequenceBuilder<Ctx>().choice('check', (ctx) => ({
      choices: [
        {
          when: { variable: ctx.assetType, stringEquals: 'video' },
          then: (b) => b.pass('videoPath', () => ({ ok: true })),
        },
      ],
    }));

    expect(builder).toBeDefined();

    type ResultCtx =
      typeof builder extends SequenceBuilder<infer C> ? C : never;

    expectTypeOf<ResultCtx>().toEqualTypeOf<Ctx>();
  });

  it('should preserve context type after fail', () => {
    type Ctx = { bucket: string; key: string };

    const builder = new SequenceBuilder<Ctx>().fail('abort', {
      error: 'Aborted',
    });

    expect(builder).toBeDefined();

    type ResultCtx =
      typeof builder extends SequenceBuilder<infer C> ? C : never;

    expectTypeOf<ResultCtx>().toEqualTypeOf<Ctx>();
  });
});

// ── statesMathAdd() ─────────────────────────────────────────────────

describe('statesMathAdd', () => {
  it('should generate States.MathAdd expression', () => {
    const proxy = createProxy<{ scene: { start_frame: number } }>();
    const expr = statesMathAdd(proxy.scene.start_frame, 1);
    expect(getExpression(expr)).toBe('States.MathAdd($.scene.start_frame, 1)');
  });

  it('should support negative operands', () => {
    const proxy = createProxy<{ scene: { end_frame: number } }>();
    const expr = statesMathAdd(proxy.scene.end_frame, -1);
    expect(getExpression(expr)).toBe('States.MathAdd($.scene.end_frame, -1)');
  });

  it('should serialize in pass Parameters', () => {
    type Ctx = { scene: { start_frame: number; end_frame: number } };

    const result = new SequenceBuilder<Ctx>()
      .pass('adjusted', (ctx) => ({
        start: statesMathAdd(ctx.scene.start_frame, 1),
        end: statesMathAdd(ctx.scene.end_frame, -1),
      }))
      .build();

    const state = result.States['Adjusted'] as Record<string, unknown>;
    const params = state['Parameters'] as Record<string, unknown>;
    expect(params['start.$']).toBe('States.MathAdd($.scene.start_frame, 1)');
    expect(params['end.$']).toBe('States.MathAdd($.scene.end_frame, -1)');
  });
});

// ── pass() with Result literal ──────────────────────────────────────

describe('pass with Result literal', () => {
  it('should produce a Pass state with Result and ResultPath', () => {
    type Ctx = { bucket: string };

    const result = new SequenceBuilder<Ctx>()
      .pass('setFlag', { result: true, resultPath: '$.isWholeVideo' })
      .build();

    expect(result.StartAt).toBe('SetFlag');
    const state = result.States['SetFlag'] as Record<string, unknown>;
    expect(state['Type']).toBe('Pass');
    expect(state['Result']).toBe(true);
    expect(state['ResultPath']).toBe('$.isWholeVideo');
    expect(state).not.toHaveProperty('Parameters');
  });

  it('should support false as a Result value', () => {
    const result = new SequenceBuilder<Record<string, never>>()
      .pass('setFlag', { result: false, resultPath: '$.isWholeVideo' })
      .build();

    const state = result.States['SetFlag'] as Record<string, unknown>;
    expect(state['Result']).toBe(false);
  });

  it('should wire Result pass between other states', () => {
    type Ctx = { bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .task(
        'loadFile',
        {
          inputSchema: LoadFileUploadInput,
          outputSchema: LoadFileUploadOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'load-file-upload' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .pass('setFlag', { result: true, resultPath: '$.ready' })
      .task(
        'runMediaInfo',
        {
          inputSchema: RunMediaInfoInput,
          outputSchema: RunMediaInfoOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          step: 'run-mediainfo' as const,
          bucket: ctx.bucket,
          key: ctx.key,
        }),
      )
      .build();

    const loadFile = result.States['LoadFile'] as Record<string, unknown>;
    expect(loadFile['Next']).toBe('SetFlag');

    const setFlag = result.States['SetFlag'] as Record<string, unknown>;
    expect(setFlag['Next']).toBe('RunMediaInfo');
    expect(setFlag).not.toHaveProperty('End');

    const runMediaInfo = result.States['RunMediaInfo'] as Record<
      string,
      unknown
    >;
    expect(runMediaInfo['End']).toBe(true);
  });

  it('should expand context with the resultPath key and result type', () => {
    type Ctx = { bucket: string };

    const builder = new SequenceBuilder<Ctx>().pass('setFlag', {
      result: true,
      resultPath: '$.isWholeVideo',
    });

    expect(builder).toBeDefined();

    type ResultCtx =
      typeof builder extends SequenceBuilder<infer C> ? C : never;

    // Original context preserved
    expectTypeOf<ResultCtx>().toHaveProperty('bucket');
    // Result key extracted from resultPath and added to context
    expectTypeOf<ResultCtx>().toHaveProperty('isWholeVideo');
    expectTypeOf<ResultCtx['isWholeVideo']>().toEqualTypeOf<boolean>();
  });
});

// ── parallel() with catch ───────────────────────────────────────────

describe('parallel with catch', () => {
  it('should produce a Catch block on the Parallel state', () => {
    type Ctx = { bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .parallel(
        'main',
        [
          new SequenceBuilder<Ctx>().task(
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
              errorEquals: ['States.ALL'],
              resultPath: '$.error',
              handler: (b) =>
                b.fail('handleError', {
                  error: 'ProcessingFailed',
                  cause: 'Something went wrong',
                }),
            },
          ],
        },
      )
      .build();

    const parallel = result.States['Main'] as Record<string, unknown>;
    expect(parallel['Type']).toBe('Parallel');

    const catchBlock = parallel['Catch'] as Record<string, unknown>[];
    expect(catchBlock).toHaveLength(1);
    expect(catchBlock[0]['ErrorEquals']).toEqual(['States.ALL']);
    expect(catchBlock[0]['ResultPath']).toBe('$.error');
    expect(catchBlock[0]['Next']).toBe('HandleError');

    // Catch handler states are merged into the outer state map
    const failState = result.States['HandleError'] as Record<string, unknown>;
    expect(failState['Type']).toBe('Fail');
    expect(failState['Error']).toBe('ProcessingFailed');
  });

  it('should support multi-state catch handler', () => {
    type Ctx = { bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .parallel(
        'main',
        [
          new SequenceBuilder<Ctx>().task(
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
              errorEquals: ['States.ALL'],
              resultPath: '$.error',
              handler: (b) =>
                b
                  .task(
                    'markFailed',
                    {
                      inputSchema: LoadFileUploadInput,
                      outputSchema: LoadFileUploadOutput,
                      functionArn: LAMBDA_ARN,
                    },
                    (ctx) => ({
                      step: 'load-file-upload' as const,
                      bucket: ctx.bucket,
                      key: ctx.key,
                    }),
                  )
                  .fail('failExecution', { cause: 'Processing failed' }),
            },
          ],
        },
      )
      .build();

    const parallel = result.States['Main'] as Record<string, unknown>;
    const catchBlock = parallel['Catch'] as Record<string, unknown>[];
    expect(catchBlock[0]['Next']).toBe('MarkFailed');

    // markFailed → failExecution wiring
    const markFailed = result.States['MarkFailed'] as Record<string, unknown>;
    expect(markFailed['Next']).toBe('FailExecution');

    const failExecution = result.States['FailExecution'] as Record<
      string,
      unknown
    >;
    expect(failExecution['Type']).toBe('Fail');
  });

  it('should omit ResultPath from Catch when not provided', () => {
    type Ctx = { bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .parallel(
        'main',
        [
          new SequenceBuilder<Ctx>().task(
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
              errorEquals: ['States.ALL'],
              handler: (b) => b.fail('handleError', { error: 'Failed' }),
            },
          ],
        },
      )
      .build();

    const parallel = result.States['Main'] as Record<string, unknown>;
    const catchBlock = parallel['Catch'] as Record<string, unknown>[];
    expect(catchBlock[0]).not.toHaveProperty('ResultPath');
  });

  it('should throw on duplicate state name in catch handler', () => {
    type Ctx = { bucket: string; key: string };

    expect(() =>
      new SequenceBuilder<Ctx>()
        .task(
          'handleError',
          {
            inputSchema: LoadFileUploadInput,
            outputSchema: LoadFileUploadOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'load-file-upload' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        )
        .parallel(
          'main',
          [
            new SequenceBuilder<Ctx>().task(
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
                errorEquals: ['States.ALL'],
                handler: (b) => b.fail('handleError', { error: 'Failed' }),
              },
            ],
          },
        )
        .build(),
    ).toThrow('Duplicate state name "HandleError"');
  });

  it('should wire parallel with catch followed by next state', () => {
    type Ctx = { bucket: string; key: string };

    const result = new SequenceBuilder<Ctx>()
      .parallel(
        'main',
        [
          new SequenceBuilder<Ctx>().task(
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
              errorEquals: ['States.ALL'],
              resultPath: '$.error',
              handler: (b) => b.fail('handleError', { error: 'Failed' }),
            },
          ],
        },
      )
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
        (ctx) => ({ step: 'finalize' as const, bucket: ctx.bucket }),
      )
      .build();

    // Parallel has Next to finalize (normal flow)
    const parallel = result.States['Main'] as Record<string, unknown>;
    expect(parallel['Next']).toBe('Finalize');

    // Catch handler exists as sibling state
    expect(result.States['HandleError']).toBeDefined();

    // Finalize is last
    const finalize = result.States['Finalize'] as Record<string, unknown>;
    expect(finalize['End']).toBe(true);
  });
});

// ── Regression: duplicate state names ───────────────────────────────

describe('duplicate state names', () => {
  const taskConfig = {
    inputSchema: z.object({ bucket: z.string() }),
    outputSchema: z.object({ result: z.string() }),
    functionArn: LAMBDA_ARN,
  };

  it('should throw when two states share a name', () => {
    const builder = new SequenceBuilder<{ bucket: string }>()
      .task('process', taskConfig, (ctx) => ({ bucket: ctx.bucket }))
      .task('process', taskConfig, (ctx) => ({ bucket: ctx.bucket }));

    expect(() => builder.build()).toThrow('Duplicate state name "Process"');
  });

  it('should throw when names collide after capitalization', () => {
    // States are keyed by capitalized name, so 'process' and 'Process'
    // would map to the same key and silently overwrite each other.
    const builder = new SequenceBuilder<{ bucket: string }>()
      .task('process', taskConfig, (ctx) => ({ bucket: ctx.bucket }))
      .task('Process', taskConfig, (ctx) => ({ bucket: ctx.bucket }));

    expect(() => builder.build()).toThrow('Duplicate state name "Process"');
  });

  it('should throw when a top-level state collides with a choice branch state', () => {
    const builder = new SequenceBuilder<{ flag: boolean }>()
      .choice('route', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.flag, booleanEquals: true },
            then: (b) => b.succeed('done'),
          },
        ],
      }))
      .succeed('done');

    expect(() => builder.build()).toThrow('Duplicate state name "Done"');
  });
});

// ── Regression: builders are immutable ──────────────────────────────

describe('builder immutability', () => {
  const taskConfig = {
    inputSchema: z.object({ bucket: z.string() }),
    outputSchema: z.object({ result: z.string() }),
    functionArn: LAMBDA_ARN,
  };

  it('appending a state does not mutate the original builder', () => {
    const base = new SequenceBuilder<{ bucket: string }>().task(
      'first',
      taskConfig,
      (ctx) => ({ bucket: ctx.bucket }),
    );

    base.task('second', taskConfig, (ctx) => ({ bucket: ctx.bucket }));

    expect(Object.keys(base.build().States)).toEqual(['First']);
  });

  it('a shared prefix can fork into independent sequences', () => {
    const base = new SequenceBuilder<{ bucket: string }>().task(
      'first',
      taskConfig,
      (ctx) => ({ bucket: ctx.bucket }),
    );

    const left = base.task('left', taskConfig, (ctx) => ({
      bucket: ctx.bucket,
    }));
    const right = base.task('right', taskConfig, (ctx) => ({
      bucket: ctx.bucket,
    }));

    expect(Object.keys(left.build().States)).toEqual(['First', 'Left']);
    expect(Object.keys(right.build().States)).toEqual(['First', 'Right']);
  });

  it('every builder method returns a new instance', () => {
    const b0 = new SequenceBuilder<{ bucket: string; flag: boolean }>();
    const b1 = b0.task('load', taskConfig, (ctx) => ({ bucket: ctx.bucket }));
    const b2 = b1.pass('reshape', (ctx) => ({ b: ctx.bucket }));
    const b3 = b2.pass('setFlag', { result: true, resultPath: '$.marker' });
    const b4 = b3.choice('route', (ctx) => ({
      choices: [
        {
          when: { variable: ctx.flag, booleanEquals: true },
          then: (b) => b,
        },
      ],
    }));
    const b5 = b4.succeed('done');

    const builders: unknown[] = [b0, b1, b2, b3, b4, b5];
    expect(new Set(builders).size).toBe(builders.length);
  });
});

// ── Regression: States.Format template escaping ─────────────────────

describe('statesFormat template escaping', () => {
  it('escapes single quotes in the template', () => {
    const ctx = createProxy<{ name: string }>();
    const expr = statesFormat("it's {}", ctx.name);
    expect(getExpression(expr)).toBe("States.Format('it\\'s {}', $.name)");
  });

  it('leaves placeholder braces untouched', () => {
    const ctx = createProxy<{ a: string; b: string }>();
    const expr = statesFormat('{}/{}', ctx.a, ctx.b);
    expect(getExpression(expr)).toBe("States.Format('{}/{}', $.a, $.b)");
  });
});

// ── Regression: refs inside arrays ──────────────────────────────────

describe('refs as array elements', () => {
  it('should throw — ASL cannot substitute paths inside arrays', () => {
    // Serialization happens at pass() time via serializeParameters
    expect(() =>
      new SequenceBuilder<{ a: string; b: string }>().pass(
        'combine',
        (ctx) => ({
          arr: [ctx.a, ctx.b],
        }),
      ),
    ).toThrow('statesArray');
  });

  it('objects containing refs inside arrays still serialize', () => {
    const result = new SequenceBuilder<{ id: string }>()
      .pass('env', (ctx) => ({
        env: [{ Name: 'ID', Value: ctx.id }],
      }))
      .build();
    const params = (result.States['Env'] as Record<string, any>).Parameters;
    expect(params.env).toEqual([{ Name: 'ID', 'Value.$': '$.id' }]);
  });

  it('statesArray() is the supported way to build an array of refs', () => {
    const result = new SequenceBuilder<{ a: string; b: string }>()
      .pass('combine', (ctx) => ({
        arr: statesArray(ctx.a, 'literal', ctx.b),
      }))
      .build();
    const params = (result.States['Combine'] as Record<string, any>).Parameters;
    expect(params['arr.$']).toBe("States.Array($.a, 'literal', $.b)");
  });
});

// ── Regression: nested refs in task payloads ────────────────────────

describe('nested refs in task payloads', () => {
  it('should serialize refs inside nested payload objects', () => {
    const config = {
      inputSchema: z.object({ nested: z.unknown() }),
      outputSchema: z.object({ r: z.string() }),
      functionArn: LAMBDA_ARN,
    };
    const result = new SequenceBuilder<{ a: string }>()
      .task('t', config, (ctx) => ({ nested: { deep: ctx.a, lit: 42 } }))
      .build();

    const payload = (result.States['T'] as Record<string, any>).Parameters
      .Payload;
    expect(payload.nested).toEqual({ 'deep.$': '$.a', lit: 42 });
  });
});

// ── Regression: terminal states must be last ────────────────────────

describe('terminal state placement', () => {
  it('should throw when states follow a Succeed', () => {
    const builder = new SequenceBuilder<{ a: string }>()
      .succeed('early')
      .pass('after', (ctx) => ({ x: ctx.a }));

    expect(() => builder.build()).toThrow(
      'Terminal state "Early" must be the last state',
    );
  });

  it('should throw when states follow a Fail', () => {
    const builder = new SequenceBuilder<{ a: string }>()
      .fail('boom', { error: 'E' })
      .pass('after', (ctx) => ({ x: ctx.a }));

    expect(() => builder.build()).toThrow(
      'Terminal state "Boom" must be the last state',
    );
  });

  it('a Fail as the last state of a choice branch is fine', () => {
    const result = new SequenceBuilder<{ flag: boolean }>()
      .choice('route', (ctx) => ({
        choices: [
          {
            when: { variable: ctx.flag, booleanEquals: true },
            then: (b) => b.fail('boom', { error: 'E' }),
          },
        ],
      }))
      .pass('after', () => ({ ok: true }))
      .build();

    expect((result.States['Boom'] as Record<string, any>).Type).toBe('Fail');
  });
});

// ── Regression: state names must be identifiers ─────────────────────

describe('state name validation', () => {
  it('should throw on names that would break the ResultPath', () => {
    expect(() =>
      new SequenceBuilder<{ a: string }>().pass('my step', (ctx) => ({
        x: ctx.a,
      })),
    ).toThrow('Invalid state name "my step"');

    expect(() => new SequenceBuilder<{ a: string }>().succeed('done!')).toThrow(
      'Invalid state name "done!"',
    );

    expect(() => new SequenceBuilder<{ a: string }>().succeed('1st')).toThrow(
      'Invalid state name "1st"',
    );
  });

  it('should accept identifier names', () => {
    expect(() =>
      new SequenceBuilder<{ a: string }>().succeed('_ok_Name2'),
    ).not.toThrow();
  });
});

// ── Catch on Task, customTask, and Map ──────────────────────────────

describe('task with catch', () => {
  const taskConfig = {
    inputSchema: z.object({ bucket: z.string() }),
    outputSchema: z.object({ result: z.string() }),
    functionArn: LAMBDA_ARN,
  };

  it('should produce a Catch block on the Task state', () => {
    const result = new SequenceBuilder<{ bucket: string }>()
      .task(
        'process',
        {
          ...taskConfig,
          retry: DEFAULT_RETRY,
          catch: [
            {
              errorEquals: ['States.TaskFailed'],
              resultPath: '$.error',
              handler: (b) =>
                b.fail('processFailed', { error: 'ProcessingFailed' }),
            },
          ],
        },
        (ctx) => ({ bucket: ctx.bucket }),
      )
      .build();

    const task = result.States['Process'] as Record<string, unknown>;
    expect(task['Type']).toBe('Task');
    // Retry and Catch coexist: retries run first, then the catch fires
    expect(task['Retry']).toEqual(DEFAULT_RETRY);

    const catchBlock = task['Catch'] as Record<string, unknown>[];
    expect(catchBlock).toHaveLength(1);
    expect(catchBlock[0]['ErrorEquals']).toEqual(['States.TaskFailed']);
    expect(catchBlock[0]['ResultPath']).toBe('$.error');
    expect(catchBlock[0]['Next']).toBe('ProcessFailed');

    const failState = result.States['ProcessFailed'] as Record<string, unknown>;
    expect(failState['Type']).toBe('Fail');
  });

  it('handler context includes the resultPath error key', () => {
    new SequenceBuilder<{ bucket: string }>().task(
      'process',
      {
        ...taskConfig,
        catch: [
          {
            errorEquals: ['States.ALL'],
            resultPath: '$.taskError',
            handler: (b) => {
              expectTypeOf(b).toExtend<
                SequenceBuilder<
                  { bucket: string } & Record<'taskError', unknown>
                >
              >();
              return b.succeed('recovered');
            },
          },
        ],
      },
      (ctx) => ({ bucket: ctx.bucket }),
    );
  });
});

describe('customTask with catch', () => {
  it('should produce a Catch block on the custom Task state', () => {
    const result = new SequenceBuilder<{ jobName: string }>()
      .customTask('submit', {
        resource: 'arn:aws:states:::batch:submitJob',
        parameters: (ctx) => ({ JobName: ctx.jobName }),
        resultPath: '$.job',
        catch: [
          {
            errorEquals: ['States.ALL'],
            handler: (b) => b.fail('submitFailed', { error: 'SubmitFailed' }),
          },
        ],
      })
      .build();

    const task = result.States['Submit'] as Record<string, unknown>;
    const catchBlock = task['Catch'] as Record<string, unknown>[];
    expect(catchBlock[0]['Next']).toBe('SubmitFailed');
    // No resultPath on the catch entry → no ResultPath key
    expect(catchBlock[0]).not.toHaveProperty('ResultPath');
    expect(result.States['SubmitFailed']).toBeDefined();
  });
});

describe('map with retry and catch', () => {
  it('should produce Retry and Catch on the Map state', () => {
    type Ctx = { scenes: { id: string }[] };

    const result = new SequenceBuilder<Ctx>()
      .map('processScenes', {
        itemsPath: '$.scenes',
        retry: DEFAULT_RETRY,
        catch: [
          {
            errorEquals: ['States.ALL'],
            resultPath: '$.mapError',
            handler: (b) => b.succeed('skipScenes'),
          },
        ],
        itemSelector: (item: MapItemRef<{ id: string }>) => ({
          scene: item.value,
        }),
        processor: (b) => b.pass('markScene', (ctx) => ({ id: ctx.scene.id })),
      })
      .build();

    const map = result.States['ProcessScenes'] as Record<string, unknown>;
    expect(map['Type']).toBe('Map');
    expect(map['Retry']).toEqual(DEFAULT_RETRY);

    const catchBlock = map['Catch'] as Record<string, unknown>[];
    expect(catchBlock[0]['Next']).toBe('SkipScenes');
    expect(catchBlock[0]['ResultPath']).toBe('$.mapError');
    expect(result.States['SkipScenes']).toBeDefined();
  });
});

describe('parallel with retry', () => {
  it('should produce a Retry block on the Parallel state', () => {
    type Ctx = { bucket: string };

    const result = new SequenceBuilder<Ctx>()
      .parallel(
        'work',
        [
          new SequenceBuilder<Ctx>().pass('branchStep', (ctx) => ({
            b: ctx.bucket,
          })),
        ],
        { retry: DEFAULT_RETRY },
      )
      .build();

    const parallel = result.States['Work'] as Record<string, unknown>;
    expect(parallel['Retry']).toEqual(DEFAULT_RETRY);
  });
});

// ── Expanded choice operators ───────────────────────────────────────

describe('serializeCondition expanded operators', () => {
  const ctx = createProxy<{
    name: string;
    count: number;
    createdAt: string;
    value: unknown;
  }>();

  it.each([
    [{ variable: ctx.name, stringLessThan: 'b' }, { StringLessThan: 'b' }],
    [
      { variable: ctx.name, stringGreaterThan: 'b' },
      { StringGreaterThan: 'b' },
    ],
    [
      { variable: ctx.name, stringLessThanEquals: 'b' },
      { StringLessThanEquals: 'b' },
    ],
    [
      { variable: ctx.name, stringGreaterThanEquals: 'b' },
      { StringGreaterThanEquals: 'b' },
    ],
    [
      { variable: ctx.name, stringMatches: 'video_*.mp4' },
      { StringMatches: 'video_*.mp4' },
    ],
    [
      { variable: ctx.count, numericGreaterThanEquals: 3 },
      { NumericGreaterThanEquals: 3 },
    ],
    [
      { variable: ctx.count, numericLessThanEquals: 3 },
      { NumericLessThanEquals: 3 },
    ],
    [
      { variable: ctx.createdAt, timestampEquals: '2026-01-01T00:00:00Z' },
      { TimestampEquals: '2026-01-01T00:00:00Z' },
    ],
    [
      { variable: ctx.createdAt, timestampLessThan: '2026-01-01T00:00:00Z' },
      { TimestampLessThan: '2026-01-01T00:00:00Z' },
    ],
    [
      { variable: ctx.createdAt, timestampGreaterThan: '2026-01-01T00:00:00Z' },
      { TimestampGreaterThan: '2026-01-01T00:00:00Z' },
    ],
    [
      {
        variable: ctx.createdAt,
        timestampLessThanEquals: '2026-01-01T00:00:00Z',
      },
      { TimestampLessThanEquals: '2026-01-01T00:00:00Z' },
    ],
    [
      {
        variable: ctx.createdAt,
        timestampGreaterThanEquals: '2026-01-01T00:00:00Z',
      },
      { TimestampGreaterThanEquals: '2026-01-01T00:00:00Z' },
    ],
    [{ variable: ctx.value, isNumeric: true }, { IsNumeric: true }],
    [{ variable: ctx.value, isString: true }, { IsString: true }],
    [{ variable: ctx.value, isBoolean: true }, { IsBoolean: true }],
    [{ variable: ctx.value, isTimestamp: true }, { IsTimestamp: true }],
  ] as const)('serializes %j', (condition, expected) => {
    const serialized = serializeCondition(condition as any);
    const { Variable, ...operator } = serialized;
    expect(typeof Variable).toBe('string');
    expect(operator).toEqual(expected);
  });

  it('expanded operators work inside compound conditions', () => {
    const serialized = serializeCondition({
      and: [
        { variable: ctx.count, numericGreaterThanEquals: 1 },
        { variable: ctx.name, stringMatches: '*.mp4' },
      ],
    });

    expect(serialized).toEqual({
      And: [
        { Variable: '$.count', NumericGreaterThanEquals: 1 },
        { Variable: '$.name', StringMatches: '*.mp4' },
      ],
    });
  });
});

// ── Runtime extra-payload-key guard ─────────────────────────────────

describe('extra payload key rejection at runtime', () => {
  const build = (
    inputSchema: z.ZodObject<z.ZodRawShape>,
    payload: Record<string, unknown>,
  ) =>
    new SequenceBuilder<{ bucket: string }>().task(
      'doThing',
      {
        inputSchema: inputSchema as never,
        outputSchema: z.object({ ok: z.boolean() }),
        functionArn: LAMBDA_ARN,
      },
      () => payload as never,
    );

  it('throws for an extra top-level key', () => {
    expect(() =>
      build(z.object({ bucket: z.string() }), { bucket: 'b', bukcet: 'typo' }),
    ).toThrow('Payload field "bukcet" is not in the input schema');
  });

  it('is not fooled by keys that exist on Object.prototype', () => {
    expect(() =>
      build(z.object({ bucket: z.string() }), { bucket: 'b', toString: 'x' }),
    ).toThrow('Payload field "toString" is not in the input schema');
  });

  it('honors schemas that accept unknown keys', () => {
    expect(() =>
      build(z.looseObject({ bucket: z.string() }), { bucket: 'b', extra: 1 }),
    ).not.toThrow();
    expect(() =>
      build(z.object({ bucket: z.string() }).catchall(z.number()), {
        bucket: 'b',
        extra: 1,
      }),
    ).not.toThrow();
    // strictObject's catchall is z.never() — still rejects
    expect(() =>
      build(z.strictObject({ bucket: z.string() }), { bucket: 'b', extra: 1 }),
    ).toThrow('Payload field "extra" is not in the input schema');
  });

  it('tolerates extra keys whose value is undefined — they are never serialized', () => {
    expect(() =>
      build(z.object({ bucket: z.string() }), {
        bucket: 'b',
        debug: undefined,
      }),
    ).not.toThrow();
  });

  it('recurses into nested object fields', () => {
    const schema = z.object({
      bucket: z.string(),
      opts: z.object({ region: z.string() }).optional(),
    });
    expect(() =>
      build(schema, { bucket: 'b', opts: { region: 'eu', regoin: 'typo' } }),
    ).toThrow('Payload field "opts.regoin" is not in the input schema');
    expect(() =>
      build(schema, { bucket: 'b', opts: { region: 'eu' } }),
    ).not.toThrow();
  });

  it('recurses into object array elements', () => {
    const schema = z.object({
      refs: z.array(z.object({ bucket: z.string(), key: z.string() })),
    });
    expect(() =>
      build(schema, {
        refs: [
          { bucket: 'b', key: 'k' },
          { bucket: 'b', key: 'k', keey: 'typo' },
        ],
      }),
    ).toThrow('Payload field "refs[1].keey" is not in the input schema');
  });
});

// ── M2: Wait state ──────────────────────────────────────────────────

describe('wait', () => {
  type Ctx = { delaySeconds: number; job: { notBefore: string } };

  it('serializes each of the four variants', () => {
    const machine = new SequenceBuilder<Ctx>()
      .wait('cooldown', { seconds: 30 })
      .wait('untilDate', { timestamp: '2026-09-01T00:00:00Z' })
      .wait('dataDelay', { secondsPath: createProxy<Ctx>().delaySeconds })
      .wait('dataDate', (c) => ({ timestampPath: c.job.notBefore }))
      .succeed('done')
      .build();

    expect(machine.States['Cooldown']).toMatchObject({
      Type: 'Wait',
      Seconds: 30,
    });
    expect(machine.States['UntilDate']).toMatchObject({
      Type: 'Wait',
      Timestamp: '2026-09-01T00:00:00Z',
    });
    expect(machine.States['DataDelay']).toMatchObject({
      Type: 'Wait',
      SecondsPath: '$.delaySeconds',
    });
    expect(machine.States['DataDate']).toMatchObject({
      Type: 'Wait',
      TimestampPath: '$.job.notBefore',
    });
  });

  it('leaves the context type unchanged', () => {
    const b = new SequenceBuilder<Ctx>().wait('w', { seconds: 1 });
    expectTypeOf(b).toEqualTypeOf<SequenceBuilder<Ctx>>();
  });

  it('requires exactly one option', () => {
    expect(() => new SequenceBuilder<Ctx>().wait('w', {} as never)).toThrow(
      'exactly one of seconds, timestamp, secondsPath, timestampPath',
    );
    expect(() =>
      new SequenceBuilder<Ctx>().wait('w', {
        seconds: 1,
        timestamp: 'x',
      } as never),
    ).toThrow('exactly one of');
  });
});

// ── M2: Timeouts and heartbeats ─────────────────────────────────────

describe('task timeouts', () => {
  type Ctx = { bucket: string; key: string; budgetSeconds: number };
  const config = {
    inputSchema: LoadFileUploadInput,
    outputSchema: LoadFileUploadOutput,
    functionArn: LAMBDA_ARN,
  };
  const payload = (ctx: Proxied<Ctx>) => ({
    step: 'load-file-upload' as const,
    bucket: ctx.bucket,
    key: ctx.key,
  });

  it('serializes static timeout and heartbeat on task', () => {
    const machine = new SequenceBuilder<Ctx>()
      .task(
        'loadFileUpload',
        { ...config, timeoutSeconds: 300, heartbeatSeconds: 60 },
        payload,
      )
      .build();

    expect(machine.States['LoadFileUpload']).toMatchObject({
      TimeoutSeconds: 300,
      HeartbeatSeconds: 60,
    });
  });

  it('serializes path variants from typed refs', () => {
    const machine = new SequenceBuilder<Ctx>()
      .task(
        'loadFileUpload',
        {
          ...config,
          timeoutSecondsPath: createProxy<Ctx>().budgetSeconds,
        },
        payload,
      )
      .build();

    expect(machine.States['LoadFileUpload']).toMatchObject({
      TimeoutSecondsPath: '$.budgetSeconds',
    });
  });

  it('serializes timeouts on customTask', () => {
    const machine = new SequenceBuilder<Ctx>()
      .customTask('transcode', {
        resource: 'arn:aws:states:::batch:submitJob',
        parameters: (ctx) => ({ Bucket: ctx.bucket }),
        resultPath: '$.transcode',
        timeoutSeconds: 3600,
      })
      .build();

    expect(machine.States['Transcode']).toMatchObject({
      TimeoutSeconds: 3600,
    });
  });

  it('rejects static + path for the same option', () => {
    expect(() =>
      new SequenceBuilder<Ctx>().task(
        'loadFileUpload',
        {
          ...config,
          timeoutSeconds: 300,
          timeoutSecondsPath: createProxy<Ctx>().budgetSeconds,
        },
        payload,
      ),
    ).toThrow('mutually exclusive');
  });
});

// ── M2: *Path choice operators ──────────────────────────────────────

describe('choice *Path operators', () => {
  type Ctx = { a: number; b: number; s: string; t: string; flag: boolean };
  const ctx = createProxy<Ctx>();

  it.each([
    [
      'stringEqualsPath',
      { variable: ctx.s, stringEqualsPath: ctx.t },
      'StringEqualsPath',
    ],
    [
      'numericLessThanPath',
      { variable: ctx.a, numericLessThanPath: ctx.b },
      'NumericLessThanPath',
    ],
    [
      'numericGreaterThanEqualsPath',
      { variable: ctx.a, numericGreaterThanEqualsPath: ctx.b },
      'NumericGreaterThanEqualsPath',
    ],
    [
      'booleanEqualsPath',
      { variable: ctx.flag, booleanEqualsPath: ctx.flag },
      'BooleanEqualsPath',
    ],
    [
      'timestampLessThanPath',
      { variable: ctx.s, timestampLessThanPath: ctx.t },
      'TimestampLessThanPath',
    ],
  ] as const)(
    'serializes %s with the operand as a path',
    (_name, condition, pascal) => {
      const serialized = serializeCondition(condition as never);
      expect(serialized['Variable']).toMatch(/^\$\./);
      expect(typeof serialized[pascal]).toBe('string');
      expect(serialized[pascal]).toMatch(/^\$\./);
    },
  );

  it('produces a working Choice state end to end', () => {
    const machine = new SequenceBuilder<Ctx>()
      .choice('compare', (c) => ({
        choices: [
          {
            when: { variable: c.a, numericLessThanPath: c.b },
            then: (b) => b.succeed('aSmaller'),
          },
        ],
        default: (b) => b.succeed('bSmaller'),
      }))
      .build();

    const choice = machine.States['Compare'] as Record<string, unknown>;
    expect((choice['Choices'] as unknown[])[0]).toMatchObject({
      Variable: '$.a',
      NumericLessThanPath: '$.b',
      Next: 'ASmaller',
    });
  });
});

// ── M2: parallel branch factories ───────────────────────────────────

describe('parallel branch factories', () => {
  type Ctx = { bucket: string; key: string };
  const extractConfig = {
    inputSchema: ExtractFramesInput,
    outputSchema: ExtractFramesOutput,
    functionArn: LAMBDA_ARN,
  };
  const transcodeConfig = {
    inputSchema: TranscodePreviewInput,
    outputSchema: TranscodePreviewOutput,
    functionArn: LAMBDA_ARN,
  };

  it('factory branches produce the same ASL as prebuilt builders', () => {
    const viaFactories = new SequenceBuilder<Ctx>()
      .parallel('process', [
        (b) =>
          b.task('extractFrames', extractConfig, (ctx) => ({
            step: 'extract-frames' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          })),
        (b) =>
          b.task('transcodePreview', transcodeConfig, (ctx) => ({
            step: 'transcode-preview' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          })),
      ])
      .build();

    const viaPrebuilt = new SequenceBuilder<Ctx>()
      .parallel('process', [
        new SequenceBuilder<Ctx>().task(
          'extractFrames',
          extractConfig,
          (ctx) => ({
            step: 'extract-frames' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        ),
        new SequenceBuilder<Ctx>().task(
          'transcodePreview',
          transcodeConfig,
          (ctx) => ({
            step: 'transcode-preview' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          }),
        ),
      ])
      .build();

    expect(viaFactories).toEqual(viaPrebuilt);
  });

  it('keeps per-index branch types through the factory form', () => {
    const b = new SequenceBuilder<Ctx>()
      .parallel('process', [
        (bb) =>
          bb.task('extractFrames', extractConfig, (ctx) => ({
            step: 'extract-frames' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          })),
        (bb) =>
          bb.task('transcodePreview', transcodeConfig, (ctx) => ({
            step: 'transcode-preview' as const,
            bucket: ctx.bucket,
            key: ctx.key,
          })),
      ])
      .pass('after', (ctx) => ({
        width: ctx.process[0].extractFrames.width,
        preview: ctx.process[1].transcodePreview.previewStorageRef,
      }));

    // If per-index inference degraded to a union, `extractFrames` would
    // not be accessible on index 0 without narrowing and this would not
    // compile; the negative cross-branch case lives in
    // type-guarantees.test.ts.
    expectTypeOf(b).not.toBeAny();
  });

  it('mixes factory and prebuilt branches', () => {
    const machine = new SequenceBuilder<Ctx>()
      .parallel('process', [
        new SequenceBuilder<Ctx>().pass('markA', () => ({ a: 1 })),
        (b) => b.pass('markB', () => ({ b: 2 })),
      ])
      .build();

    const state = machine.States['Process'] as { Branches: unknown[] };
    expect(state.Branches).toHaveLength(2);
  });
});

// ── M2: optional output fields require an explicit resultSelector ───

describe('optional output fields', () => {
  type Ctx = { videoId: string };
  const OptionalOutput = z.object({
    transcript: z.string().optional(),
    always: z.string(),
  });
  const config = {
    inputSchema: z.object({ videoId: z.string() }),
    outputSchema: OptionalOutput,
    functionArn: LAMBDA_ARN,
  };

  it('throws at build time without an explicit resultSelector', () => {
    expect(() =>
      new SequenceBuilder<Ctx>().task(
        'transcribe',
        config as never,
        ((ctx: Proxied<Ctx>) => ({ videoId: ctx.videoId })) as never,
      ),
    ).toThrow('output schema field(s) transcript are optional');
  });

  it('builds fine with an explicit resultSelector', () => {
    const machine = new SequenceBuilder<Ctx>()
      .task(
        'transcribe',
        {
          ...config,
          resultSelector: (output) => ({ always: output.always }),
        },
        (ctx) => ({ videoId: ctx.videoId }),
      )
      .build();

    expect(machine.States['Transcribe']).toMatchObject({
      ResultSelector: { 'always.$': '$.Payload.always' },
    });
  });
});

// ── Type-tightening pass: customTask context honesty ────────────────

describe('customTask context typing', () => {
  type Ctx = { parentVideoId: string };

  it('keys the context by the resultPath, not the state name', () => {
    const b = new SequenceBuilder<Ctx>()
      .customTask('transcode', {
        resource: 'arn:aws:states:::batch:submitJob',
        parameters: (ctx) => ({ JobName: ctx.parentVideoId }),
        resultPath: '$.transcodeJob',
        outputSchema: z.object({ JobId: z.string() }),
      })
      .pass('after', (ctx) => ({
        // The data lives at $.transcodeJob — and so does the type.
        jobId: ctx.transcodeJob.JobId,
      }));

    type After = InferContext<typeof b>;
    expectTypeOf<After['transcodeJob']>().toEqualTypeOf<{ JobId: string }>();
    expectTypeOf<After['after']>().toEqualTypeOf<{ jobId: string }>();

    const machine = b.build();
    const after = machine.States['After'] as Record<string, unknown>;
    expect(after['Parameters']).toEqual({ 'jobId.$': '$.transcodeJob.JobId' });
  });

  it('without resultPath, the result replaces the whole input', () => {
    const b = new SequenceBuilder<Ctx>().customTask('fetch', {
      resource: 'arn:aws:states:::aws-sdk:s3:getObject',
      parameters: () => ({ Bucket: 'b' }),
      outputSchema: z.object({ Body: z.string() }),
    });

    // ASL's default ResultPath is '$' — the context is now the output
    // alone; parentVideoId is gone.
    expectTypeOf(b).toEqualTypeOf<SequenceBuilder<{ Body: string }>>();
  });

  it('without an outputSchema the result is untyped but still keyed correctly', () => {
    const b = new SequenceBuilder<Ctx>().customTask('submit', {
      resource: 'arn:aws:states:::batch:submitJob',
      parameters: () => ({}),
      resultPath: '$.job',
    });

    expectTypeOf(b).toEqualTypeOf<
      SequenceBuilder<Ctx & Record<'job', Record<string, unknown>>>
    >();
  });

  it('rejects a resultPath that is not $.{identifier}', () => {
    expect(() =>
      new SequenceBuilder<Ctx>().customTask('submit', {
        resource: 'arn:aws:states:::batch:submitJob',
        parameters: () => ({}),
        resultPath: '$.a.b' as '$.x',
      }),
    ).toThrow('must be "$.{key}" with a single identifier key');
  });
});

// ── Type-tightening pass: map items ref selector ────────────────────

describe('map items ref selector', () => {
  type Scene = { id: string; startFrame: number };
  type Ctx = { scenes: Scene[]; bucket: string };

  it('serializes ItemsPath from the typed ref', () => {
    const machine = new SequenceBuilder<Ctx>()
      .map('processScenes', {
        items: (ctx) => ctx.scenes,
        itemSelector: (item, ctx) => ({
          scene: item.value,
          bucket: ctx.bucket,
        }),
        processor: (b) => b.pass('mark', (c) => ({ id: c.scene.id })),
      })
      .build();

    const state = machine.States['ProcessScenes'] as Record<string, unknown>;
    expect(state['ItemsPath']).toBe('$.scenes');
  });

  it('infers ItemType from the ref — item.value is typed', () => {
    new SequenceBuilder<Ctx>().map('processScenes', {
      items: (ctx) => ctx.scenes,
      itemSelector: (item, ctx) => {
        expectTypeOf(item.value.startFrame).toExtend<Ref<number>>();
        return { start: item.value.startFrame, bucket: ctx.bucket };
      },
      processor: (b) => b.pass('mark', (c) => ({ s: c.start })),
    });
  });

  it('throws when neither items nor itemsPath is given', () => {
    expect(() =>
      new SequenceBuilder<Ctx>().map('processScenes', {
        itemSelector: (item: MapItemRef<Scene>) => ({ scene: item.value }),
        processor: (b: SequenceBuilder<{ scene: Scene }>) =>
          b.pass('mark', () => ({ ok: true })),
      } as never),
    ).toThrow('needs either items (a typed ref selector) or itemsPath');
  });
});

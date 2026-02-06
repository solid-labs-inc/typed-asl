import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_RETRY,
  type RetryConfig,
  SequenceBuilder,
  THROTTLE_RETRY,
} from './builder.js';
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

      expect(result.StartAt).toBe('loadFileUpload');
      expect(Object.keys(result.States)).toEqual(['loadFileUpload']);

      const state = result.States['loadFileUpload'] as Record<string, unknown>;
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

      expect(result.StartAt).toBe('loadFileUpload');

      const first = result.States['loadFileUpload'] as Record<string, unknown>;
      expect(first['Next']).toBe('runMediaInfo');
      expect(first).not.toHaveProperty('End');

      const second = result.States['runMediaInfo'] as Record<string, unknown>;
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

      expect(result.StartAt).toBe('loadFileUpload');

      const s1 = result.States['loadFileUpload'] as Record<string, unknown>;
      expect(s1['Next']).toBe('runMediaInfo');

      const s2 = result.States['runMediaInfo'] as Record<string, unknown>;
      expect(s2['Next']).toBe('createVideo');

      const s3 = result.States['createVideo'] as Record<string, unknown>;
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

      const state = result.States['runMediaInfo'] as Record<string, unknown>;
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

      const state = result.States['loadFileUpload'] as Record<string, unknown>;
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

      const state = result.States['transcribe'] as Record<string, unknown>;
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

      const state = result.States['createVideo'] as Record<string, unknown>;
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

      const state = result.States['runMediaInfo'] as Record<string, unknown>;
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

      const state = result.States['loadFileUpload'] as Record<string, unknown>;
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

      const state = result.States['loadFileUpload'] as Record<string, unknown>;
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

      const state = result.States['loadFileUpload'] as Record<string, unknown>;
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

      expect(result.StartAt).toBe('process');

      const state = result.States['process'] as Record<string, unknown>;
      expect(state['Type']).toBe('Parallel');
      expect(state['ResultPath']).toBe('$.process');
      expect(state['End']).toBe(true);

      const branches = state['Branches'] as {
        StartAt: string;
        States: Record<string, unknown>;
      }[];
      expect(branches).toHaveLength(2);

      expect(branches[0].StartAt).toBe('extractFrames');
      expect(branches[0].States['extractFrames']).toBeDefined();

      expect(branches[1].StartAt).toBe('transcodePreview');
      expect(branches[1].States['transcodePreview']).toBeDefined();
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

      const parallel = result.States['process'] as Record<string, unknown>;
      expect(parallel['Next']).toBe('finalize');
      expect(parallel).not.toHaveProperty('End');

      const finalize = result.States['finalize'] as Record<string, unknown>;
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

      const outer = result.States['outer'] as Record<string, unknown>;
      expect(outer['Type']).toBe('Parallel');

      const branches = outer['Branches'] as {
        StartAt: string;
        States: Record<string, unknown>;
      }[];
      expect(branches).toHaveLength(2);

      // Branch 0 should have two states: extractFrames → descriptions
      expect(branches[0].StartAt).toBe('extractFrames');
      expect(Object.keys(branches[0].States)).toEqual([
        'extractFrames',
        'descriptions',
      ]);

      // The nested parallel
      const nested = branches[0].States['descriptions'] as Record<
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
      expect(nestedBranches[0].StartAt).toBe('generateEmbedding');
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

      expect(result.StartAt).toBe('filterOutput');

      const state = result.States['filterOutput'] as Record<string, unknown>;
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

      const state = result.States['addDefaults'] as Record<string, unknown>;
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

      const task = result.States['loadFileUpload'] as Record<string, unknown>;
      expect(task['Next']).toBe('reshape');

      const pass = result.States['reshape'] as Record<string, unknown>;
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

      const state = result.States['loadFileUpload'] as Record<string, unknown>;
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
      StartAt: 'loadFileUpload',
      States: {
        loadFileUpload: {
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
          Next: 'runMediaInfo',
        },
        runMediaInfo: {
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
          Next: 'createVideo',
        },
        createVideo: {
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
      StartAt: 'process',
      States: {
        process: {
          Type: 'Parallel',
          ResultPath: '$.process',
          Branches: [
            {
              StartAt: 'extractFrames',
              States: {
                extractFrames: {
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
              StartAt: 'transcodePreview',
              States: {
                transcodePreview: {
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
          Next: 'finalize',
        },
        finalize: {
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

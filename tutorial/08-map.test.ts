/**
 * Chapter 8: Map — Iteration with Dual Context
 *
 * A Map state iterates over an array in the state data, running a processor
 * sub-machine for each element. This introduces a unique challenge: inside
 * the processor, you need access to two contexts:
 *
 *   - `$` — the outer state data (shared across all iterations)
 *   - `$$` — the iteration context (`$$.Map.Item.Value` and `$$.Map.Item.Index`)
 *
 * The `itemSelector` callback bridges these two worlds. It receives:
 *   - `item.value` — a typed proxy rooted at `$$.Map.Item.Value`
 *   - `item.index` — a typed proxy for `$$.Map.Item.Index`
 *   - `ctx` — the outer state data proxy (rooted at `$`)
 *
 * The return value of `itemSelector` becomes the processor's initial context,
 * with refs unwrapped to their real types.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';

import { SequenceBuilder, createMapItemProxy, pathOf } from '../src/index.js';
import type { MapItemRef, Ref } from '../src/index.js';

describe('Chapter 8: Map — Iteration with Dual Context', () => {
  // ── Shared schemas ───────────────────────────────────────────────────

  const StorageRef = z.object({ bucket: z.string(), key: z.string() });

  const ExtractFramesInput = z.object({
    step: z.literal('extract-frames'),
    sceneId: z.string(),
    startFrame: z.number(),
    endFrame: z.number(),
    outputBucket: z.string(),
  });

  const ExtractFramesOutput = z.object({
    frameStorageRefs: z.array(StorageRef),
  });

  const LAMBDA_ARN = '${lambda_arn}';

  // ── createMapItemProxy ───────────────────────────────────────────────

  it('createMapItemProxy creates $$ -rooted proxies for iteration', () => {
    // The Map state's iteration variables are rooted at $$ (context object),
    // not $ (state data). createMapItemProxy creates proxies for both.
    type Scene = { id: string; startFrame: number; endFrame: number };
    const item = createMapItemProxy<Scene>();

    // item.value is the current array element ($$.Map.Item.Value)
    expect(pathOf(item.value)).toBe('$$.Map.Item.Value');
    expect(pathOf(item.value.id)).toBe('$$.Map.Item.Value.id');
    expect(pathOf(item.value.startFrame)).toBe('$$.Map.Item.Value.startFrame');

    // item.index is the current iteration index ($$.Map.Item.Index)
    expect(pathOf(item.index)).toBe('$$.Map.Item.Index');

    // Types are preserved
    expectTypeOf(item.value.id).toExtend<Ref<string>>();
    expectTypeOf(item.value.startFrame).toExtend<Ref<number>>();
    expectTypeOf(item.index).toExtend<Ref<number>>();
  });

  // ── Basic map state ──────────────────────────────────────────────────

  it('map iterates over an array with a typed processor', () => {
    type Scene = { id: string; startFrame: number; endFrame: number };
    type Input = {
      scenes: Scene[];
      outputBucket: string;
    };

    const asl = new SequenceBuilder<Input>()
      .map('processScenes', {
        itemsPath: '$.scenes',
        maxConcurrency: 5,
        itemSelector: (item: MapItemRef<Scene>, ctx) => ({
          // Mix iteration context ($$) with outer context ($)
          sceneId: item.value.id,
          startFrame: item.value.startFrame,
          endFrame: item.value.endFrame,
          outputBucket: ctx.outputBucket,
        }),
        processor: (b) =>
          b.task(
            'extractFrames',
            {
              inputSchema: ExtractFramesInput,
              outputSchema: ExtractFramesOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({
              step: 'extract-frames' as const,
              // The processor context is inferred from itemSelector's return,
              // with refs unwrapped to their actual types.
              sceneId: ctx.sceneId, // string (unwrapped from Ref<string>)
              startFrame: ctx.startFrame, // number
              endFrame: ctx.endFrame, // number
              outputBucket: ctx.outputBucket, // string
            })
          ),
      })
      .build();

    const mapState = asl.States.ProcessScenes as Record<string, any>;
    expect(mapState.Type).toBe('Map');
    expect(mapState.ItemsPath).toBe('$.scenes');
    expect(mapState.MaxConcurrency).toBe(5);
    expect(mapState.ResultPath).toBe('$.processScenes');

    // The ItemSelector bridges $$ and $ context
    expect(mapState.ItemSelector).toEqual({
      'sceneId.$': '$$.Map.Item.Value.id',
      'startFrame.$': '$$.Map.Item.Value.startFrame',
      'endFrame.$': '$$.Map.Item.Value.endFrame',
      'outputBucket.$': '$.outputBucket',
    });

    // The processor is a nested state machine
    expect(mapState.ItemProcessor.StartAt).toBe('ExtractFrames');
    expect(mapState.ItemProcessor.ProcessorConfig.Mode).toBe('INLINE');
  });

  // ── Map output type ──────────────────────────────────────────────────

  it('map output is typed as ProcessorOutput[]', () => {
    type Scene = { id: string; startFrame: number; endFrame: number };
    type Input = { scenes: Scene[]; outputBucket: string };

    const builder = new SequenceBuilder<Input>().map('processScenes', {
      itemsPath: '$.scenes',
      itemSelector: (item: MapItemRef<Scene>, ctx) => ({
        sceneId: item.value.id,
        startFrame: item.value.startFrame,
        endFrame: item.value.endFrame,
        outputBucket: ctx.outputBucket,
      }),
      processor: (b) =>
        b.task(
          'extractFrames',
          {
            inputSchema: ExtractFramesInput,
            outputSchema: ExtractFramesOutput,
            functionArn: LAMBDA_ARN,
          },
          (ctx) => ({
            step: 'extract-frames' as const,
            sceneId: ctx.sceneId,
            startFrame: ctx.startFrame,
            endFrame: ctx.endFrame,
            outputBucket: ctx.outputBucket,
          })
        ),
    });

    // The map result is an array — one entry per iteration.
    // Each entry has the processor's accumulated context.
    type Ctx = typeof builder._ctx;
    expectTypeOf<Ctx['processScenes']>().toBeArray();
  });

  // ── Using map output downstream ──────────────────────────────────────

  it('downstream tasks can reference the map output array', () => {
    type Scene = { id: string; startFrame: number; endFrame: number };
    type Input = { scenes: Scene[]; outputBucket: string };

    const FinalizeInput = z.object({
      step: z.literal('finalize'),
      sceneResults: z.unknown(),
    });
    const FinalizeOutput = z.object({ compositionId: z.string() });

    const asl = new SequenceBuilder<Input>()
      .map('processScenes', {
        itemsPath: '$.scenes',
        itemSelector: (item: MapItemRef<Scene>, ctx) => ({
          sceneId: item.value.id,
          startFrame: item.value.startFrame,
          endFrame: item.value.endFrame,
          outputBucket: ctx.outputBucket,
        }),
        processor: (b) =>
          b.task(
            'extractFrames',
            {
              inputSchema: ExtractFramesInput,
              outputSchema: ExtractFramesOutput,
              functionArn: LAMBDA_ARN,
            },
            (ctx) => ({
              step: 'extract-frames' as const,
              sceneId: ctx.sceneId,
              startFrame: ctx.startFrame,
              endFrame: ctx.endFrame,
              outputBucket: ctx.outputBucket,
            })
          ),
      })
      .task(
        'finalize',
        {
          inputSchema: FinalizeInput,
          outputSchema: FinalizeOutput,
          functionArn: LAMBDA_ARN,
        },
        (ctx) => ({
          // Reference the entire map output array
          step: 'finalize' as const,
          sceneResults: ctx.processScenes,
        })
      )
      .build();

    const finalizePayload = (asl.States.Finalize as any).Parameters.Payload;
    expect(finalizePayload['sceneResults.$']).toBe('$.processScenes');
  });
});

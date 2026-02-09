import { z } from 'zod';

import { getExpression, isIntrinsic } from './intrinsic.js';
import { createMapItemProxy, createProxy, isRef, pathOf } from './proxy.js';
import type { MapItemRef } from './proxy.js';
import type {
  AnyZodObject,
  Proxied,
  Ref,
  TypedPayloadMapping,
} from './types.js';

// ── Retry presets ───────────────────────────────────────────────────

export interface RetryConfig {
  ErrorEquals: string[];
  IntervalSeconds: number;
  BackoffRate: number;
  MaxAttempts: number;
}

export const DEFAULT_RETRY: RetryConfig[] = [
  {
    ErrorEquals: ['States.ALL'],
    IntervalSeconds: 2,
    BackoffRate: 2,
    MaxAttempts: 3,
  },
];

export const THROTTLE_RETRY: RetryConfig[] = [
  {
    ErrorEquals: ['ThrottlingException', 'Lambda.TooManyRequestsException'],
    IntervalSeconds: 2,
    BackoffRate: 2,
    MaxAttempts: 10,
  },
  ...DEFAULT_RETRY,
];

// ── Config types ────────────────────────────────────────────────────

export interface LambdaTaskConfig<
  I extends AnyZodObject,
  O extends AnyZodObject
> {
  inputSchema: I;
  outputSchema: O;
  functionArn: string;
  retry?: RetryConfig[];
  /**
   * Override the auto-generated ResultSelector.
   *
   * By default, each output schema key maps to `$.Payload.{key}`.
   * Use this to rename keys from the Lambda's actual response.
   *
   * @example
   * ```ts
   * // Lambda returns { outputStorageRef }, but we want { storageRef } in context
   * resultSelector: {
   *   'storageRef.$': '$.Payload.outputStorageRef',
   *   'width.$': '$.Payload.width',
   * }
   * ```
   */
  resultSelector?: Record<string, string>;
}

export interface AslStateMachine {
  Comment?: string;
  StartAt: string;
  States: Record<string, object>;
}

/**
 * Unwrap `Ref<T>` to `T` for each property in a record.
 * Used to infer the output type of a `pass()` state from its mapping function.
 */
export type UnwrapRefs<M> = {
  [K in keyof M]: M[K] extends Ref<infer U> ? U : M[K];
};

/**
 * Given a tuple of SequenceBuilders, produce a tuple of their
 * "delta" outputs — keys each branch added beyond the shared Base context.
 *
 * Uses TypeScript's mapped tuple handling: when `Branches` is a tuple,
 * `{ [I in keyof Branches]: ... }` produces a tuple, not a numeric-keyed object.
 *
 * @example
 * ```ts
 * type Result = BranchOutputTuple<
 *   { bucket: string },
 *   [SequenceBuilder<{ bucket: string } & { frames: FrameOut }>,
 *    SequenceBuilder<{ bucket: string } & { preview: PreviewOut }>]
 * >;
 * // = [{ frames: FrameOut }, { preview: PreviewOut }]
 * ```
 */
export type BranchOutputTuple<
  Base,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Branches extends readonly SequenceBuilder<any>[]
> = {
  [I in keyof Branches]: Branches[I] extends SequenceBuilder<infer Full>
    ? Omit<Full, keyof Base>
    : never;
};

/**
 * Configuration for a Map state.
 *
 * @typeParam Ctx - The current builder context (data path `$`).
 * @typeParam ItemType - The type of each element in the iterated array.
 */
export interface MapConfig<Ctx, ItemType> {
  /** JSONPath to the array to iterate (e.g. `'$.scenes'`). */
  itemsPath: string;
  /** Max concurrent iterations (default: unlimited). */
  maxConcurrency?: number;
  /**
   * Maps each iteration's context object (`$$`) and the outer state data (`$`)
   * to the ItemProcessor's initial context.
   *
   * `item.value` is `$$.Map.Item.Value`, `item.index` is `$$.Map.Item.Index`.
   * `ctx` is the outer state data (`$`-rooted proxy).
   */
  itemSelector: (
    item: MapItemRef<ItemType>,
    ctx: Proxied<Ctx>
  ) => Record<string, unknown>;
  /** Pre-built ASL state machine for the ItemProcessor. */
  processor: AslStateMachine;
}

/**
 * Configuration for a custom (non-Lambda) Task state.
 */
export interface CustomTaskConfig<Ctx> {
  /** The task resource ARN (e.g. `'arn:aws:states:::batch:submitJob'`). */
  resource: string;
  /**
   * Callback that builds the ASL Parameters object.
   * Supports refs and intrinsic functions at any nesting depth.
   */
  parameters: (ctx: Proxied<Ctx>) => Record<string, unknown>;
  /** Where to store the result (e.g. `'$.transcodeJob'`). Omit to replace input. */
  resultPath?: string;
  retry?: RetryConfig[];
}

// ── SequenceBuilder ─────────────────────────────────────────────────

/**
 * Builds a sequence of Step Function states with type-safe context accumulation.
 *
 * Each `.task()` call appends a Lambda Task state and expands the context
 * type with that state's output. The payload callback receives a typed proxy
 * of the current context, so every ref is validated at compile time.
 *
 * `.build()` wires up `Next`/`End` pointers and returns the ASL structure.
 *
 * @example
 * ```ts
 * type Input = { bucket: string; key: string };
 *
 * const result = new SequenceBuilder<Input>()
 *   .task('runMediaInfo', {
 *     inputSchema: RunMediainfoStepInput,
 *     outputSchema: RunMediainfoStepOutput,
 *     functionArn: LAMBDA_ARN,
 *   }, ctx => ({
 *     bucket: ctx.bucket,
 *     key: ctx.key,
 *   }))
 *   .task('createVideo', {
 *     inputSchema: CreateVideoInput,
 *     outputSchema: CreateVideoOutput,
 *     functionArn: LAMBDA_ARN,
 *   }, ctx => ({
 *     mediaInfo: ctx.runMediaInfo.mediaInfo,
 *   }))
 *   .build();
 * ```
 */
export class SequenceBuilder<Ctx> {
  /** @internal Type-level only — does not exist at runtime. */
  declare readonly _ctx: Ctx;

  private _states: [name: string, state: Record<string, unknown>][] = [];

  /** Create a new builder. Equivalent to `new SequenceBuilder<T>()` but chainable. */
  static create<T>(): SequenceBuilder<T> {
    return new SequenceBuilder<T>();
  }

  /**
   * Apply a transform function to this builder, enabling reusable task
   * definitions while keeping a flat chain.
   *
   * @param fn - A function that appends one or more states to the builder.
   *   Typically a generic function constrained to require specific upstream
   *   outputs in the context.
   * @returns The builder returned by `fn`.
   *
   * @example
   * ```ts
   * const addCreateAtlas = <Ctx extends { extractFrames: { frameStorageRefs: StorageRef[] } }>(
   *   b: SequenceBuilder<Ctx>
   * ) => b.task('createAtlas', createAtlasConfig, ctx => ({
   *   frameStorageRefs: ctx.extractFrames.frameStorageRefs,
   *   outputFilename: 'atlas.webp',
   * }));
   *
   * new SequenceBuilder<Input>()
   *   .task('extractFrames', extractConfig, ctx => ({ ... }))
   *   .pipe(addCreateAtlas)
   *   .task('finalize', finalizeConfig, ctx => ({ ... }))
   *   .build();
   * ```
   */
  pipe<NewCtx>(
    fn: (builder: SequenceBuilder<Ctx>) => SequenceBuilder<NewCtx>
  ): SequenceBuilder<NewCtx> {
    return fn(this);
  }

  /**
   * Append a Lambda Task state to the sequence.
   *
   * @param name - State name and context key. The result of this state
   *   is stored at `$.{name}` and becomes available as `ctx.{name}` in
   *   subsequent payload callbacks.
   * @param config - Input/output schemas, Lambda ARN, and retry config.
   * @param payloadFn - Callback that maps the current context to the
   *   Lambda payload. TypeScript ensures every required field is present
   *   and refs have the correct type.
   * @returns A new builder with an expanded context that includes this
   *   state's output keyed by `name`.
   */
  task<Name extends string, I extends AnyZodObject, O extends AnyZodObject>(
    name: Name,
    config: LambdaTaskConfig<I, O>,
    payloadFn: (ctx: Proxied<Ctx>) => TypedPayloadMapping<I>
  ): SequenceBuilder<Ctx & Record<Name, z.infer<O>>> {
    const proxy = createProxy<Ctx>();
    const mappedPayload = payloadFn(proxy);

    const aslPayload = buildAslPayload(config.inputSchema, mappedPayload);
    const resultSelector =
      config.resultSelector ?? buildResultSelector(config.outputSchema);

    const state: Record<string, unknown> = {
      Type: 'Task',
      Resource: 'arn:aws:states:::lambda:invoke',
      ResultPath: `$.${name}`,
      ResultSelector: resultSelector,
      Parameters: {
        FunctionName: config.functionArn,
        Payload: aslPayload,
      },
    };

    if (config.retry) {
      state['Retry'] = config.retry;
    }

    this._states.push([name, state]);

    return this as unknown as SequenceBuilder<Ctx & Record<Name, z.infer<O>>>;
  }

  /**
   * Append a Parallel state to the sequence.
   *
   * Each branch is a `SequenceBuilder` whose context starts from the
   * current context `Ctx`. The parallel result is stored at `$.{name}`
   * as a tuple where each index corresponds to a branch's accumulated
   * output (minus the shared initial context).
   *
   * @param name - State name and context key for the parallel result.
   * @param branches - Tuple of SequenceBuilders, one per branch.
   *   Use `[...] as const` or a literal array to preserve tuple types.
   * @returns A new builder whose context includes the parallel output
   *   tuple keyed by `name`.
   *
   * @example
   * ```ts
   * builder.parallel('process', [
   *   new SequenceBuilder<Ctx>()
   *     .task('extractFrames', extractConfig, ctx => ({ ... })),
   *   new SequenceBuilder<Ctx>()
   *     .task('transcode', transcodeConfig, ctx => ({ ... })),
   * ])
   * // ctx.process[0].extractFrames  → branch 0's output
   * // ctx.process[1].transcode      → branch 1's output
   * ```
   */
  parallel<
    Name extends string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Branches extends readonly SequenceBuilder<any>[]
  >(
    name: Name,
    branches: [...Branches]
  ): SequenceBuilder<Ctx & Record<Name, BranchOutputTuple<Ctx, Branches>>> {
    const aslBranches = branches.map((b) => b.build());

    const state: Record<string, unknown> = {
      Type: 'Parallel',
      ResultPath: `$.${name}`,
      Branches: aslBranches,
    };

    this._states.push([name, state]);

    return this as unknown as SequenceBuilder<
      Ctx & Record<Name, BranchOutputTuple<Ctx, Branches>>
    >;
  }

  /**
   * Append a Pass state to the sequence.
   *
   * A Pass state reshapes data without invoking a Lambda. The mapping
   * function defines the output parameters using refs from the current
   * context or static values.
   *
   * @param name - State name (and context key when resultPath is not null).
   * @param mappingFn - Callback that maps the current context to the
   *   output parameters. Ref values become JSONPath entries, static
   *   values are kept as-is.
   * @param options - Optional configuration.
   * @param options.resultPath - Set to `null` to omit ResultPath entirely
   *   (output replaces the full state input). Useful for filtering at the
   *   end of a Map iteration.
   * @returns A new builder whose context includes the pass output.
   *
   * @example
   * ```ts
   * // With ResultPath (default): result stored at $.filterOutput
   * builder.pass('filterOutput', ctx => ({
   *   sceneIndex: ctx.scene.id,
   *   videoId: ctx.createVideoAssetForScene.videoId,
   * }))
   *
   * // Without ResultPath: output replaces entire input
   * builder.pass('filterOutput', ctx => ({
   *   sceneIndex: ctx.scene.id,
   *   videoId: ctx.createVideoAssetForScene.videoId,
   * }), { resultPath: null })
   * ```
   */
  pass<Name extends string, M extends Record<string, unknown>>(
    name: Name,
    mappingFn: (ctx: Proxied<Ctx>) => M,
    options?: { resultPath?: null }
  ): SequenceBuilder<Ctx & Record<Name, UnwrapRefs<M>>> {
    const proxy = createProxy<Ctx>();
    const mapped = mappingFn(proxy);

    const parameters = serializeParameters(mapped);

    const state: Record<string, unknown> = {
      Type: 'Pass',
      Parameters: parameters,
    };

    if (options?.resultPath !== null) {
      state['ResultPath'] = `$.${name}`;
    }

    this._states.push([name, state]);

    return this as unknown as SequenceBuilder<
      Ctx & Record<Name, UnwrapRefs<M>>
    >;
  }

  /**
   * Append a Map state to the sequence.
   *
   * Iterates over an array in the state data, running the ItemProcessor
   * for each element with configurable concurrency.
   *
   * @typeParam Name - State name and context key for the Map result.
   * @typeParam ItemType - Type of each element in the iterated array.
   * @typeParam MapOutput - Type of each iteration's output (defaults to `unknown`).
   *   The Map result is `MapOutput[]`, stored at `$.{name}`.
   *
   * @example
   * ```ts
   * builder.map<'extractScenes', Scene, SceneResult>('extractScenes', {
   *   itemsPath: '$.scenes',
   *   maxConcurrency: 5,
   *   itemSelector: (item, ctx) => ({
   *     scene: item.value,
   *     sceneIndex: item.index,
   *     inputStorageRef: ctx.previewStorageRef,
   *   }),
   *   processor: sceneProcessor.build(),
   * })
   * ```
   */
  map<Name extends string, ItemType, MapOutput = unknown>(
    name: Name,
    config: MapConfig<Ctx, ItemType>
  ): SequenceBuilder<Ctx & Record<Name, MapOutput[]>> {
    const outerProxy = createProxy<Ctx>();
    const itemProxy = createMapItemProxy<ItemType>();
    const selectorMapping = config.itemSelector(itemProxy, outerProxy);
    const itemSelector = serializeParameters(selectorMapping);

    const state: Record<string, unknown> = {
      Type: 'Map',
      ItemsPath: config.itemsPath,
      ResultPath: `$.${name}`,
      ItemSelector: itemSelector,
      ItemProcessor: {
        ProcessorConfig: { Mode: 'INLINE' },
        StartAt: config.processor.StartAt,
        States: config.processor.States,
      },
    };

    if (config.maxConcurrency !== undefined) {
      state['MaxConcurrency'] = config.maxConcurrency;
    }

    this._states.push([name, state]);

    return this as unknown as SequenceBuilder<Ctx & Record<Name, MapOutput[]>>;
  }

  /**
   * Append a custom (non-Lambda) Task state to the sequence.
   *
   * Use this for resources like AWS Batch (`batch:submitJob`), SNS, SQS, etc.
   * The parameters callback supports refs and intrinsic functions at any
   * nesting depth.
   *
   * @typeParam Name - State name and context key.
   * @typeParam O - Output type (defaults to `Record<string, unknown>`).
   *
   * @example
   * ```ts
   * builder.customTask('transcode', {
   *   resource: 'arn:aws:states:::batch:submitJob',
   *   parameters: ctx => ({
   *     JobDefinition: JOB_DEF_ARN,
   *     JobQueue: JOB_QUEUE_ARN,
   *     JobName: statesFormat('Transcode-{}', ctx.parentVideoId),
   *     ContainerOverrides: {
   *       Environment: [
   *         { Name: 'DATA', Value: statesJsonToString(ctx.data) },
   *       ],
   *     },
   *   }),
   *   resultPath: '$.transcodeJob',
   * })
   * ```
   */
  customTask<Name extends string, O = Record<string, unknown>>(
    name: Name,
    config: CustomTaskConfig<Ctx>
  ): SequenceBuilder<Ctx & Record<Name, O>> {
    const proxy = createProxy<Ctx>();
    const rawParams = config.parameters(proxy);
    const parameters = serializeParameters(rawParams);

    const state: Record<string, unknown> = {
      Type: 'Task',
      Resource: config.resource,
      Parameters: parameters,
    };

    if (config.resultPath !== undefined) {
      state['ResultPath'] = config.resultPath;
    }

    if (config.retry) {
      state['Retry'] = config.retry;
    }

    this._states.push([name, state]);

    return this as unknown as SequenceBuilder<Ctx & Record<Name, O>>;
  }

  /**
   * Build the final ASL state machine structure.
   *
   * Wires up `Next` pointers between sequential states and sets `End: true`
   * on the last state.
   *
   * @param options - Optional configuration for the state machine.
   * @param options.comment - A human-readable description of the state machine.
   * @throws If the builder has no states.
   */
  build(options?: { comment?: string }): AslStateMachine {
    if (this._states.length === 0) {
      throw new Error('SequenceBuilder has no states');
    }

    const states: Record<string, object> = {};

    for (let i = 0; i < this._states.length; i++) {
      const [name, state] = this._states[i];
      const copy = { ...state };

      if (i === this._states.length - 1) {
        copy['End'] = true;
      } else {
        copy['Next'] = capitalize(this._states[i + 1][0]);
      }

      states[capitalize(name)] = copy;
    }

    return {
      ...(options?.comment ? { Comment: options.comment } : {}),
      StartAt: capitalize(this._states[0][0]),
      States: states,
    };
  }
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Recursively serialize a parameters object for ASL.
 *
 * - Ref values → `"key.$": "$.path"`
 * - IntrinsicExpr values → `"key.$": "States.Format(...)"`
 * - Nested objects → recursed
 * - Arrays → each element recursed if it's an object
 * - Primitives → kept as-is
 */
export function serializeParameters(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (isRef(value)) {
      result[`${key}.$`] = pathOf(value);
    } else if (isIntrinsic(value)) {
      result[`${key}.$`] = getExpression(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => serializeItem(item));
    } else if (typeof value === 'object' && value !== null) {
      result[key] = serializeParameters(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function serializeItem(item: unknown): unknown {
  if (isRef(item)) {
    return pathOf(item);
  }
  if (isIntrinsic(item)) {
    return getExpression(item);
  }
  if (Array.isArray(item)) {
    return item.map((i) => serializeItem(i));
  }
  if (typeof item === 'object' && item !== null) {
    return serializeParameters(item as Record<string, unknown>);
  }
  return item;
}

/**
 * Build the ASL Payload object from a typed payload mapping.
 *
 * - Extracts the discriminator literal (`step` or `task`) from the input schema
 * - Converts Ref values to `"key.$": "$.path"` JSONPath entries
 * - Keeps static values as `"key": value`
 */
function buildAslPayload(
  inputSchema: AnyZodObject,
  mappedPayload: Record<string, unknown>
): Record<string, unknown> {
  const aslPayload: Record<string, unknown> = {};

  const discriminator = extractDiscriminator(inputSchema);
  if (discriminator) {
    aslPayload[discriminator.field] = discriminator.value;
  }

  for (const [key, value] of Object.entries(mappedPayload)) {
    if (isRef(value)) {
      aslPayload[`${key}.$`] = pathOf(value);
    } else if (isIntrinsic(value)) {
      aslPayload[`${key}.$`] = getExpression(value);
    } else {
      aslPayload[key] = value;
    }
  }

  return aslPayload;
}

/**
 * Auto-generate the ASL ResultSelector from an output schema.
 *
 * Produces `{ "key.$": "$.Payload.key" }` for every key in the schema.
 */
function buildResultSelector(
  outputSchema: AnyZodObject
): Record<string, string> {
  const selector: Record<string, string> = {};
  for (const key of Object.keys(outputSchema.shape)) {
    selector[`${key}.$`] = `$.Payload.${key}`;
  }
  return selector;
}

/**
 * Extract the discriminator literal from a schema.
 *
 * Checks `step` first, then `task`. Returns the field name and value.
 * Supports Zod 4's internal representation (`_zod.def.values` as an array)
 * and Zod 3's `.value` property as a fallback.
 */
function extractDiscriminator(
  schema: AnyZodObject
): { field: string; value: string } | undefined {
  for (const field of ['step', 'task']) {
    const schemaField = schema.shape[field];
    if (!schemaField) continue;

    const value = extractLiteralValue(schemaField);
    if (value !== undefined) {
      return { field, value };
    }
  }
  return undefined;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractLiteralValue(schemaField: unknown): string | undefined {
  // Zod 4: literal schemas store values in _zod.def.values (array)
  const zod = (
    schemaField as {
      _zod?: { def?: { type?: string; values?: unknown[] } };
    }
  )?._zod;
  if (
    zod?.def?.type === 'literal' &&
    Array.isArray(zod.def.values) &&
    typeof zod.def.values[0] === 'string'
  ) {
    return zod.def.values[0];
  }

  // Zod 3 fallback: .value property
  if (
    schemaField != null &&
    typeof schemaField === 'object' &&
    'value' in schemaField &&
    typeof (schemaField as { value: unknown }).value === 'string'
  ) {
    return (schemaField as { value: string }).value;
  }

  return undefined;
}

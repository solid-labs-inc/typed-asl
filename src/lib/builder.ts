import type { z } from 'zod';
import { serializeCondition, type ChoiceCondition } from './choice.js';
import { getExpression, isIntrinsic, type IntrinsicExpr } from './intrinsic.js';
import type { PathValue } from './path.js';
import type { MapItemRef } from './proxy.js';
import { createMapItemProxy, createProxy, isRef, pathOf } from './proxy.js';
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

export const EXTERNAL_API_RETRY: RetryConfig[] = [
  {
    ErrorEquals: ['States.ALL'],
    IntervalSeconds: 5,
    BackoffRate: 2,
    MaxAttempts: 6,
  },
];

// ── Config types ────────────────────────────────────────────────────

export interface LambdaTaskConfig<
  I extends AnyZodObject,
  O extends AnyZodObject,
> {
  inputSchema: I;
  outputSchema: O;
  functionArn: string;
  retry?: RetryConfig[];
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
  [K in keyof M]: M[K] extends Ref<infer U>
    ? U
    : M[K] extends IntrinsicExpr<infer U>
      ? U
      : M[K];
};

/**
 * Extract the accumulated context type from a SequenceBuilder.
 *
 * @example
 * ```ts
 * const builder = new SequenceBuilder<{ bucket: string }>()
 *   .task('runMediaInfo', config, ctx => ({ ... }))
 *   .task('createVideo', config, ctx => ({ ... }));
 *
 * type Output = InferContext<typeof builder>;
 * // = { bucket: string; runMediaInfo: MediaInfoOutput; createVideo: VideoOutput }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InferContext<B extends SequenceBuilder<any>> =
  B extends SequenceBuilder<infer Ctx> ? Ctx : never;

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _Base,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Branches extends readonly SequenceBuilder<any>[],
> = {
  [I in keyof Branches]: Branches[I] extends SequenceBuilder<infer Full>
    ? Full
    : never;
};

/**
 * Configuration for a Map state.
 *
 * @typeParam Ctx - The current builder context (data path `$`).
 * @typeParam ItemType - The type of each element in the iterated array.
 * @typeParam S - The selector's return type (inferred).
 * @typeParam ProcessorCtx - The processor's output context type (inferred from callback).
 */
export interface MapConfig<
  Ctx,
  ItemType,
  S extends Record<string, unknown>,
  ProcessorCtx,
> {
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
   *
   * When the processor accesses properties on `item.value`, annotate the
   * `item` parameter with `MapItemRef<T>` so the type flows through.
   */
  itemSelector: (item: MapItemRef<ItemType>, ctx: Proxied<Ctx>) => S;
  /**
   * Callback that receives a builder typed from the itemSelector output
   * (refs and intrinsics unwrapped) and returns the processor chain.
   *
   * For pre-built processors, ignore the builder parameter:
   * ```ts
   * processor: () => myProcessor
   * ```
   */
  processor: (
    b: SequenceBuilder<UnwrapRefs<S>>,
  ) => SequenceBuilder<ProcessorCtx>;
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

// ── Catch types ─────────────────────────────────────────────────────

const CATCH_HANDLERS: unique symbol = Symbol('catchHandlers');

/**
 * Sentinel value used when a Choice state's empty branch or default has no
 * convergence target yet (e.g. the choice is the last state in a sub-builder).
 * The parent's `rewireTerminals` call replaces it with the real next state.
 */
const PENDING_NEXT = '__PENDING_NEXT__';

/**
 * Configuration for a Catch block on a Parallel or Task state.
 *
 * @typeParam Ctx - The current builder context.
 * @typeParam Key - The key extracted from `resultPath` (e.g. `'error'` from `'$.error'`).
 *   When provided, the handler context is extended with `Record<Key, unknown>`.
 */
export interface CatchConfig<Ctx, Key extends string = never> {
  errorEquals: string[];
  resultPath?: `$.${Key}`;

  handler: (
    b: SequenceBuilder<Ctx & Record<Key, unknown>>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => SequenceBuilder<any>;
}

interface CatchEntry {
  errorEquals: string[];
  resultPath?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder: SequenceBuilder<any>;
}

// ── Choice types ────────────────────────────────────────────────────

const CHOICE_MARKER: unique symbol = Symbol('choice');

/**
 * A single branch of a Choice state.
 *
 * @typeParam Ctx - The current builder context.
 */
export interface ChoiceBranch<Ctx> {
  when: ChoiceCondition;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then: (b: SequenceBuilder<Ctx>) => SequenceBuilder<any>;
}

/**
 * Configuration for a Choice state.
 *
 * @typeParam Ctx - The current builder context.
 */
export interface ChoiceConfig<Ctx> {
  choices: ChoiceBranch<Ctx>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default?: (b: SequenceBuilder<Ctx>) => SequenceBuilder<any>;
}

interface ChoiceBlock {
  branches: {
    condition: Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    builder: SequenceBuilder<any>;
  }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultBuilder?: SequenceBuilder<any>;
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

  /** @internal */
  _states: [name: string, state: Record<string, unknown>][] = [];

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
    fn: (builder: SequenceBuilder<Ctx>) => SequenceBuilder<NewCtx>,
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

  /**
   * Overload: `resultSelector` + `resultPath: null` — the selector reshapes
   * the Lambda output, then the result replaces the entire state input.
   */
  task<
    Name extends string,
    I extends AnyZodObject,
    O extends AnyZodObject,
    R extends Record<string, unknown>,
  >(
    name: Name,
    config: LambdaTaskConfig<I, O> & {
      resultSelector: (output: Proxied<z.infer<O>>) => R;
      resultPath: null;
    },
    payloadFn: (ctx: Proxied<Ctx>) => TypedPayloadMapping<I>,
  ): SequenceBuilder<UnwrapRefs<R>>;

  /**
   * Overload: `resultPath: null` without `resultSelector` — the full Lambda
   * output replaces the entire state input.
   */
  task<Name extends string, I extends AnyZodObject, O extends AnyZodObject>(
    name: Name,
    config: LambdaTaskConfig<I, O> & { resultPath: null },
    payloadFn: (ctx: Proxied<Ctx>) => TypedPayloadMapping<I>,
  ): SequenceBuilder<z.infer<O>>;

  /**
   * Overload: with `resultSelector` — a typed mapping function that remaps
   * the Lambda's actual output (described by `outputSchema`) into the shape
   * stored in the context. The context type is derived from the mapping's
   * return type.
   */
  task<
    Name extends string,
    I extends AnyZodObject,
    O extends AnyZodObject,
    R extends Record<string, unknown>,
  >(
    name: Name,
    config: LambdaTaskConfig<I, O> & {
      resultSelector: (output: Proxied<z.infer<O>>) => R;
    },
    payloadFn: (ctx: Proxied<Ctx>) => TypedPayloadMapping<I>,
  ): SequenceBuilder<Ctx & Record<Name, UnwrapRefs<R>>>;

  /**
   * Overload: without `resultSelector` — auto-generates a 1:1 mapping from
   * the output schema keys. The context type matches `z.infer<O>`.
   */
  task<Name extends string, I extends AnyZodObject, O extends AnyZodObject>(
    name: Name,
    config: LambdaTaskConfig<I, O>,
    payloadFn: (ctx: Proxied<Ctx>) => TypedPayloadMapping<I>,
  ): SequenceBuilder<Ctx & Record<Name, z.infer<O>>>;

  task(
    name: string,
    config: LambdaTaskConfig<AnyZodObject, AnyZodObject> & {
      resultSelector?: (output: Proxied<unknown>) => Record<string, unknown>;
      resultPath?: null;
    },
    payloadFn: (ctx: Proxied<Ctx>) => Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): SequenceBuilder<any> {
    const proxy = createProxy<Ctx>();
    const mappedPayload = payloadFn(proxy);

    const aslPayload = buildAslPayload(config.inputSchema, mappedPayload);

    let resultSelector: Record<string, unknown>;
    if (typeof config.resultSelector === 'function') {
      const outputProxy = createProxy<unknown>(['$', 'Payload']);
      const mapped = config.resultSelector(outputProxy);
      resultSelector = serializeParameters(mapped);
    } else {
      resultSelector = buildResultSelector(config.outputSchema);
    }

    const state: Record<string, unknown> = {
      Type: 'Task',
      Resource: 'arn:aws:states:::lambda:invoke',
      ResultSelector: resultSelector,
      Parameters: {
        FunctionName: config.functionArn,
        Payload: aslPayload,
      },
    };

    if (config.resultPath !== null) {
      state['ResultPath'] = `$.${name}`;
    }

    if (config.retry) {
      state['Retry'] = config.retry;
    }

    this._states.push([name, state]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as unknown as SequenceBuilder<any>;
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
    Branches extends readonly SequenceBuilder<any>[],
    CatchKey extends string = never,
  >(
    name: Name,
    branches: [...Branches],
    options?: { catch?: CatchConfig<Ctx, CatchKey>[] },
  ): SequenceBuilder<Ctx & Record<Name, BranchOutputTuple<Ctx, Branches>>>;

  parallel(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    branches: SequenceBuilder<any>[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: { catch?: CatchConfig<any, any>[] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): SequenceBuilder<any> {
    const aslBranches = branches.map((b) => b.build());

    const state: Record<string, unknown> = {
      Type: 'Parallel',
      ResultPath: `$.${name}`,
      Branches: aslBranches,
    };

    if (options?.catch) {
      const catchEntries: CatchEntry[] = options.catch.map((c) => ({
        errorEquals: c.errorEquals,
        resultPath: c.resultPath,
        builder: c.handler(new SequenceBuilder<Ctx>()),
      }));
      (state as Record<string | symbol, unknown>)[CATCH_HANDLERS] =
        catchEntries;
    }

    this._states.push([name, state]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as unknown as SequenceBuilder<any>;
  }

  /**
   * Append a Pass state that reshapes data using a mapping function.
   *
   * @param name - State name (and context key when resultPath is not null).
   * @param mappingFn - Callback that maps the current context to the
   *   output parameters. Ref values become JSONPath entries, static
   *   values are kept as-is.
   * @param options - Optional configuration.
   * @param options.resultPath - Set to `null` to omit ResultPath entirely
   *   (output replaces the full state input).
   *
   * @example
   * ```ts
   * builder.pass('filterOutput', ctx => ({
   *   sceneIndex: ctx.scene.id,
   *   videoId: ctx.createVideoAssetForScene.videoId,
   * }))
   * ```
   */
  /**
   * Overload: `resultPath: null` — output replaces the entire state input.
   * The new context type is `UnwrapRefs<M>` (the mapping function's output).
   */
  pass<Name extends string, M extends Record<string, unknown>>(
    name: Name,
    mappingFn: (ctx: Proxied<Ctx>) => M,
    options: { resultPath: null },
  ): SequenceBuilder<UnwrapRefs<M>>;

  /**
   * Overload: no options — result stored at `$.{name}`, added to context.
   */
  pass<Name extends string, M extends Record<string, unknown>>(
    name: Name,
    mappingFn: (ctx: Proxied<Ctx>) => M,
  ): SequenceBuilder<Ctx & Record<Name, UnwrapRefs<M>>>;

  /**
   * Append a Pass state that injects a literal value at a given path.
   *
   * The `resultPath` must be a `$.{key}` string. The context is expanded
   * with `Record<key, R>` so the value is available downstream.
   *
   * @param name - State name.
   * @param config - The literal `result` value and `resultPath` to store it.
   *
   * @example
   * ```ts
   * builder.pass('setFlag', { result: true, resultPath: '$.isWholeVideo' })
   * // ctx.isWholeVideo is now boolean
   * ```
   */
  pass<R, Key extends string>(
    name: string,
    config: { result: R; resultPath: `$.${Key}` },
  ): SequenceBuilder<Ctx & Record<Key, R>>;

  pass(
    name: string,
    mappingFnOrConfig:
      | ((ctx: Proxied<Ctx>) => Record<string, unknown>)
      | { result: unknown; resultPath: string },
    options?: { resultPath?: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): SequenceBuilder<any> {
    // Overload 2: literal Result
    if (typeof mappingFnOrConfig !== 'function') {
      const state: Record<string, unknown> = {
        Type: 'Pass',
        Result: mappingFnOrConfig.result,
        ResultPath: mappingFnOrConfig.resultPath,
      };
      this._states.push([name, state]);
      return this;
    }

    // Overload 1: mapping function
    const proxy = createProxy<Ctx>();
    const mapped = mappingFnOrConfig(proxy);

    const parameters = serializeParameters(mapped);

    const state: Record<string, unknown> = {
      Type: 'Pass',
      Parameters: parameters,
    };

    if (options?.resultPath !== null) {
      state['ResultPath'] = `$.${name}`;
    }

    this._states.push([name, state]);
    return this;
  }

  /**
   * Append a Map state to the sequence.
   *
   * Iterates over an array in the state data, running the ItemProcessor
   * for each element with configurable concurrency.
   *
   * The `processor` callback receives a builder whose context is inferred
   * from the `itemSelector` return (refs and intrinsics are unwrapped).
   * For pre-built processors, ignore the builder parameter.
   *
   * When the processor needs to access properties on `item.value`, annotate
   * the `item` parameter with `MapItemRef<T>` so the type flows through.
   *
   * @example
   * ```ts
   * // Pre-built processor (ignore b)
   * builder.map('processScenes', {
   *   itemsPath: '$.scenes',
   *   itemSelector: (item, ctx) => ({ scene: item.value }),
   *   processor: () => sceneProcessor,
   * })
   *
   * // Inline processor — context inferred from selector
   * builder.map('extractAudio', {
   *   itemsPath: '$.sentences',
   *   itemSelector: (item: MapItemRef<Sentence>, ctx) => ({
   *     sentence: item.value,
   *     audioRef: ctx.audioStorageRef,
   *   }),
   *   processor: (b) => b.task('extract', extractConfig, (ctx) => ({
   *     startSeconds: ctx.sentence.startSeconds,  // typed from selector
   *     input: ctx.audioRef,                      // typed from selector
   *   })),
   * })
   * ```
   */
  /**
   * Overload: `itemsPath` is a string literal — inferred `ItemType`.
   */
  map<
    Name extends string,
    ItemsPath extends string,
    S extends Record<string, unknown>,
    ProcessorCtx,
  >(
    name: Name,
    config: MapConfig<
      Ctx,
      PathValue<Ctx, ItemsPath> extends (infer I)[] ? I : never,
      S,
      ProcessorCtx
    > & {
      itemsPath: ItemsPath;
    },
  ): SequenceBuilder<Ctx & Record<Name, ProcessorCtx[]>>;

  map<
    Name extends string,
    ItemType,
    S extends Record<string, unknown>,
    ProcessorCtx,
  >(
    name: Name,
    config: MapConfig<Ctx, ItemType, S, ProcessorCtx>,
  ): SequenceBuilder<Ctx & Record<Name, ProcessorCtx[]>>;

  map(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: MapConfig<any, any, any, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): SequenceBuilder<any> {
    const outerProxy = createProxy<Ctx>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemProxy = createMapItemProxy<any>();
    const selectorMapping = config.itemSelector(itemProxy, outerProxy);
    const itemSelector = serializeParameters(selectorMapping);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = config.processor(new SequenceBuilder<any>());
    const built = processor.build();

    const state: Record<string, unknown> = {
      Type: 'Map',
      ItemsPath: config.itemsPath,
      ResultPath: `$.${name}`,
      ItemSelector: itemSelector,
      ItemProcessor: {
        ProcessorConfig: { Mode: 'INLINE' },
        StartAt: built.StartAt,
        States: built.States,
      },
    };

    if (config.maxConcurrency !== undefined) {
      state['MaxConcurrency'] = config.maxConcurrency;
    }

    this._states.push([name, state]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as unknown as SequenceBuilder<any>;
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
    config: CustomTaskConfig<Ctx>,
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
   * Append a Choice state to the sequence.
   *
   * A Choice state evaluates conditions and routes execution to the
   * matching branch. All non-terminal branches automatically converge
   * to the next state after the choice (implicit convergence).
   *
   * @param name - State name for the Choice state.
   * @param configFn - Callback that receives the typed context proxy and
   *   returns a `ChoiceConfig` with conditions and branch builders.
   * @returns The same builder (context type unchanged — can't know which
   *   branch will execute at runtime).
   *
   * @example
   * ```ts
   * builder.choice('checkType', ctx => ({
   *   choices: [
   *     {
   *       when: { variable: ctx.assetType, stringEquals: 'video' },
   *       then: b => b.task('processVideo', videoConfig, c => ({ ... })),
   *     },
   *   ],
   *   default: b => b.fail('unknownType', { error: 'UnknownAssetType' }),
   * }))
   * ```
   */
  choice(
    name: string,
    configFn: (ctx: Proxied<Ctx>) => ChoiceConfig<Ctx>,
  ): SequenceBuilder<Ctx>;

  /**
   * Assert that all branches of the choice produce common fields.
   * The `Adds` type is merged into the context after the choice.
   *
   * @example
   * ```ts
   * builder.choice<{ isWholeVideo: boolean }>('checkSceneCount', ctx => ({
   *   choices: [
   *     { when: ..., then: b => b.pass('setFlag', { result: false, resultPath: '$.isWholeVideo' }) },
   *   ],
   *   default: b => b.pass('setFlag', { result: true, resultPath: '$.isWholeVideo' }),
   * }))
   * // ctx.isWholeVideo is now boolean
   * ```
   */
  choice<Adds>(
    name: string,
    configFn: (ctx: Proxied<Ctx>) => ChoiceConfig<Ctx>,
  ): SequenceBuilder<Ctx & Adds>;

  choice(
    name: string,
    configFn: (ctx: Proxied<Ctx>) => ChoiceConfig<Ctx>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): SequenceBuilder<any> {
    const proxy = createProxy<Ctx>();
    const config = configFn(proxy);

    const branches = config.choices.map((branch) => {
      const condition = serializeCondition(branch.when);
      const builder = branch.then(new SequenceBuilder<Ctx>());
      return { condition, builder };
    });

    const defaultBuilder = config.default
      ? config.default(new SequenceBuilder<Ctx>())
      : undefined;

    const block: ChoiceBlock = { branches, defaultBuilder };

    // Store as a special marker entry
    const state: Record<string, unknown> = { [CHOICE_MARKER]: block };
    this._states.push([name, state]);

    return this;
  }

  /**
   * Append a Fail state to the sequence.
   *
   * A Fail state terminates the execution with an error. It has no
   * `Next` or `End` field in ASL.
   *
   * @param name - State name for the Fail state.
   * @param config - Error and cause strings.
   *
   * @example
   * ```ts
   * builder.fail('validationFailed', {
   *   error: 'ValidationError',
   *   cause: 'Input file is not a supported format',
   * })
   * ```
   */
  fail(
    name: string,
    config: { error?: string; cause?: string },
  ): SequenceBuilder<Ctx> {
    const state: Record<string, unknown> = { Type: 'Fail' };
    if (config.error !== undefined) state['Error'] = config.error;
    if (config.cause !== undefined) state['Cause'] = config.cause;

    this._states.push([name, state]);
    return this;
  }

  /**
   * Append a Succeed state to the sequence.
   *
   * A Succeed state terminates the execution successfully. It has no
   * `Next` or `End` field in ASL. Use this inside choice branches to
   * end the execution early without error.
   *
   * @param name - State name for the Succeed state.
   *
   * @example
   * ```ts
   * builder.choice('checkDuplicate', ctx => ({
   *   choices: [{
   *     when: { variable: ctx.loadResult.duplicate, booleanEquals: true },
   *     then: b => b.succeed('skipDuplicate'),
   *   }],
   *   default: b => b,
   * }))
   * ```
   */
  succeed(name: string): SequenceBuilder<Ctx> {
    this._states.push([name, { Type: 'Succeed' }]);
    return this;
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
      const nextStateName =
        i < this._states.length - 1
          ? capitalize(this._states[i + 1][0])
          : undefined;
      const isLast = i === this._states.length - 1;

      // ── Choice block ────────────────────────────────────────────
      if (CHOICE_MARKER in state) {
        const block = state[CHOICE_MARKER] as ChoiceBlock;
        const choices: Record<string, unknown>[] = [];

        // When the choice is the last state in the sequence, empty branches
        // and the implicit default need an auto-generated Pass end state
        // instead of PENDING_NEXT (which would never be resolved).
        let endPassStateName: string | undefined;
        const getOrCreateEndPass = (): string => {
          if (!endPassStateName) {
            endPassStateName = `${capitalize(name)}End`;
            states[endPassStateName] = { Type: 'Pass', End: true };
          }
          return endPassStateName;
        };

        for (const { condition, builder } of block.branches) {
          if (builder._states.length === 0) {
            // Empty branch → skip directly to convergence (or end)
            choices.push({
              ...condition,
              Next: nextStateName ?? getOrCreateEndPass(),
            });
          } else {
            const branchMachine = builder.build();
            // Check for name collisions
            for (const bName of Object.keys(branchMachine.States)) {
              if (states[bName]) {
                throw new Error(
                  `Duplicate state name "${bName}" in choice "${name}"`,
                );
              }
            }
            if (nextStateName) {
              rewireTerminals(
                branchMachine.States as Record<string, Record<string, unknown>>,
                nextStateName,
              );
            }
            Object.assign(states, branchMachine.States);
            choices.push({ ...condition, Next: branchMachine.StartAt });
          }
        }

        const choiceState: Record<string, unknown> = {
          Type: 'Choice',
          Choices: choices,
        };

        if (block.defaultBuilder) {
          if (block.defaultBuilder._states.length === 0) {
            choiceState['Default'] = nextStateName ?? getOrCreateEndPass();
          } else {
            const defaultMachine = block.defaultBuilder.build();
            for (const bName of Object.keys(defaultMachine.States)) {
              if (states[bName]) {
                throw new Error(
                  `Duplicate state name "${bName}" in choice "${name}" default branch`,
                );
              }
            }
            if (nextStateName) {
              rewireTerminals(
                defaultMachine.States as Record<
                  string,
                  Record<string, unknown>
                >,
                nextStateName,
              );
            }
            Object.assign(states, defaultMachine.States);
            choiceState['Default'] = defaultMachine.StartAt;
          }
        } else {
          choiceState['Default'] = nextStateName ?? getOrCreateEndPass();
        }

        states[capitalize(name)] = choiceState;
        continue;
      }

      // ── Terminal states (Fail / Succeed) ────────────────────────
      if (state['Type'] === 'Fail' || state['Type'] === 'Succeed') {
        states[capitalize(name)] = { ...state };
        continue;
      }

      // ── Normal state ────────────────────────────────────────────
      const copy = { ...state };
      delete (copy as Record<string | symbol, unknown>)[CATCH_HANDLERS];

      if (isLast) {
        copy['End'] = true;
      } else {
        copy['Next'] = nextStateName;
      }

      // Handle Catch handlers (Parallel, Task states)
      if (CATCH_HANDLERS in state) {
        const handlers = (state as Record<string | symbol, unknown>)[
          CATCH_HANDLERS
        ] as CatchEntry[];
        const aslCatch: Record<string, unknown>[] = [];

        for (const handler of handlers) {
          const handlerMachine = handler.builder.build();
          for (const bName of Object.keys(handlerMachine.States)) {
            if (states[bName]) {
              throw new Error(
                `Duplicate state name "${bName}" in catch handler for "${name}"`,
              );
            }
          }
          Object.assign(states, handlerMachine.States);
          aslCatch.push({
            ErrorEquals: handler.errorEquals,
            ...(handler.resultPath ? { ResultPath: handler.resultPath } : {}),
            Next: handlerMachine.StartAt,
          });
        }

        copy['Catch'] = aslCatch;
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
 * Rewire terminal states in a flat states map to point to `nextStateName`
 * instead of ending. Fail states are left untouched (they're always terminal).
 *
 * Only touches top-level states — nested Parallel/Map branch states live
 * inside their container's `Branches`/`ItemProcessor` arrays and are unaffected.
 */
function rewireTerminals(
  states: Record<string, Record<string, unknown>>,
  nextStateName: string,
): void {
  for (const state of Object.values(states)) {
    if (
      state['End'] === true &&
      state['Type'] !== 'Fail' &&
      state['Type'] !== 'Succeed'
    ) {
      delete state['End'];
      state['Next'] = nextStateName;
    }

    // Resolve pending convergence targets in Choice states
    if (state['Type'] === 'Choice') {
      if (state['Default'] === PENDING_NEXT) {
        state['Default'] = nextStateName;
      }
      const choices = state['Choices'] as Record<string, unknown>[] | undefined;
      if (choices) {
        for (const choice of choices) {
          if (choice['Next'] === PENDING_NEXT) {
            choice['Next'] = nextStateName;
          }
        }
      }
    }
  }
}

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
  obj: Record<string, unknown>,
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
 * - Converts Ref values to `"key.$": "$.path"` JSONPath entries
 * - Keeps static values as `"key": value`
 */
function buildAslPayload(
  _inputSchema: AnyZodObject,
  mappedPayload: Record<string, unknown>,
): Record<string, unknown> {
  const aslPayload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(mappedPayload)) {
    if (value === undefined) continue;
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
  outputSchema: AnyZodObject,
): Record<string, string> {
  const selector: Record<string, string> = {};
  for (const key of Object.keys(outputSchema.shape)) {
    selector[`${key}.$`] = `$.Payload.${key}`;
  }
  return selector;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

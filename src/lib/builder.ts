import type { z } from 'zod';
import { serializeCondition, type ChoiceCondition } from './choice.js';
import { getExpression, isIntrinsic, type IntrinsicExpr } from './intrinsic.js';
import type { PathValue } from './path.js';
import type { MapItemRef } from './proxy.js';
import { createMapItemProxy, createProxy, isRef, pathOf } from './proxy.js';
import type {
  AnyZodObject,
  ExactPayload,
  Proxied,
  Ref,
  RequireNoOptionalOutputs,
  RequireResultSelectorForOptionalOutputs,
  TypedPayloadMapping,
} from './types.js';

// ── Retry presets ───────────────────────────────────────────────────

/**
 * Error names predefined by the ASL spec, plus the Lambda service errors
 * that show up in real Retry/Catch configs.
 */
export type KnownAslError =
  | 'States.ALL'
  | 'States.BranchFailed'
  | 'States.DataLimitExceeded'
  | 'States.ExceedToleratedFailureThreshold'
  | 'States.HeartbeatTimeout'
  | 'States.IntrinsicFailure'
  | 'States.ItemReaderFailed'
  | 'States.NoChoiceMatched'
  | 'States.ParameterPathFailure'
  | 'States.Permissions'
  | 'States.ResultPathMatchFailure'
  | 'States.ResultWriterFailed'
  | 'States.Runtime'
  | 'States.TaskFailed'
  | 'States.Timeout'
  | 'Lambda.AWSLambdaException'
  | 'Lambda.ClientExecutionTimeoutException'
  | 'Lambda.SdkClientException'
  | 'Lambda.ServiceException'
  | 'Lambda.TooManyRequestsException';

/**
 * An error name for `ErrorEquals`: the known names autocomplete, and any
 * custom error string (your Lambda's own error types) stays legal — the
 * `& Record<never, never>` keeps the union from collapsing to `string`,
 * which would kill completion.
 */
export type AslErrorName = KnownAslError | (string & Record<never, never>);

export interface RetryConfig {
  ErrorEquals: AslErrorName[];
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

/**
 * State-level timeout options shared by `task` and `customTask`.
 *
 * `timeoutSeconds`/`heartbeatSeconds` take a static number; the `...Path`
 * variants read the value from the state data at execution time. Each
 * pair is mutually exclusive (enforced at build time — ASL rejects a
 * state carrying both).
 */
export interface TimeoutConfig {
  timeoutSeconds?: number;
  timeoutSecondsPath?: Ref<number>;
  heartbeatSeconds?: number;
  heartbeatSecondsPath?: Ref<number>;
}

export interface LambdaTaskConfig<
  I extends AnyZodObject,
  O extends AnyZodObject,
> extends TimeoutConfig {
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
 * A single `parallel` branch: either a prebuilt builder, or a factory
 * that receives a fresh builder seeded with the current context — like
 * `choice` branches. The factory form keeps branch contexts in sync with
 * the chain automatically instead of repeating `new SequenceBuilder<Ctx>()`.
 */
export type BranchInput<Ctx> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | SequenceBuilder<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | ((b: SequenceBuilder<Ctx>) => SequenceBuilder<any>);

/**
 * Given a tuple of branches (builders or factories — see `BranchInput`),
 * produce a tuple of their output contexts.
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
 * // = [{ bucket: string; frames: FrameOut }, { bucket: string; preview: PreviewOut }]
 * ```
 */
export type BranchOutputTuple<
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _Base,
  // `readonly BranchInput<X>[]` would trip function-parameter
  // contravariance when X varies, but `(b: never) => ...` accepts every
  // factory for the same reason — so the constraint stays precise.
  Branches extends readonly (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | SequenceBuilder<any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | ((b: never) => SequenceBuilder<any>)
  )[],
> = {
  [I in keyof Branches]: Branches[I] extends SequenceBuilder<infer Full>
    ? Full
    : Branches[I] extends (b: never) => SequenceBuilder<infer Full>
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
  CatchKey extends string = never,
> {
  /**
   * JSONPath to the array to iterate (e.g. `'$.scenes'`). Prefer `items`
   * — it autocompletes and typos don't compile; a literal path here is
   * type-checked against the context but without completion. Exactly one
   * of `itemsPath`/`items` is required (enforced at build time).
   */
  itemsPath?: string;
  /** Typed ref selector for the array to iterate — preferred. */
  items?: (ctx: Proxied<Ctx>) => Ref<readonly ItemType[]>;
  /** Max concurrent iterations (default: unlimited). */
  maxConcurrency?: number;
  retry?: RetryConfig[];
  catch?: CatchConfig<Ctx, CatchKey>[];
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
export interface CustomTaskConfig<
  Ctx,
  CatchKey extends string = never,
> extends TimeoutConfig {
  /** The task resource ARN (e.g. `'arn:aws:states:::batch:submitJob'`). */
  resource: string;
  /**
   * Callback that builds the ASL Parameters object.
   * Supports refs and intrinsic functions at any nesting depth.
   */
  parameters: (ctx: Proxied<Ctx>) => Record<string, unknown>;
  /**
   * Where to store the result, as `$.{key}` — the context type is keyed
   * by `key`. Omit to have the result replace the entire state input
   * (ASL's default), which the context type also reflects.
   */
  resultPath?: string;
  /**
   * Drives the result exactly like `task`'s output schema: a
   * `ResultSelector` is generated projecting each schema key from the
   * raw result (`{ "key.$": "$.key" }`), and the context is typed as
   * `z.infer` of it. Optional fields are rejected — the selector
   * references every key and ASL errors at runtime on absent ones. Omit
   * for the raw, untyped result.
   */
  outputSchema?: AnyZodObject;
  retry?: RetryConfig[];
  catch?: CatchConfig<Ctx, CatchKey>[];
}

/**
 * Configuration for a Wait state: exactly one of a static duration, a
 * static RFC3339 timestamp, or a typed ref to either in the state data.
 */
export type WaitConfig =
  | { seconds: number }
  | { timestamp: string }
  | { secondsPath: Ref<number> }
  | { timestampPath: Ref<string> };

// ── Catch types ─────────────────────────────────────────────────────

const CATCH_HANDLERS: unique symbol = Symbol('catchHandlers');

/**
 * State names double as JSONPath keys (`ResultPath: "$.{name}"`) and context
 * keys (`ctx.{name}`), so they must be plain identifiers — a space or dot
 * would produce a path AWS rejects at creation time.
 */
const STATE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A context-keyed `resultPath` must be `$.{identifier}` — the context
 * type is keyed by that identifier, so a nested or exotic path would
 * desynchronize types from the runtime data location.
 */
const RESULT_PATH = /^\$\.[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Compile-time companion to {@link RESULT_PATH}, intersected into every
 * context-keyed `resultPath` property (`customTask`, `pass`, catch
 * configs): when the inferred key contains a `.` or `[`, the property
 * type collapses to `never`, so `resultPath: '$.a.b'` is a compile error
 * anchored on the property. Nested ResultPaths are deliberately
 * unrepresentable — the context type could not describe where the data
 * lives.
 */
export type ResultPathKeyCheck<Key extends string> = Key extends
  `${string}.${string}` | `${string}[${string}`
  ? never
  : `$.${Key}`;

/**
 * Runtime companion for plain-JS callers: same rule as
 * {@link ResultPathKeyCheck}.
 */
function assertResultPathKey(
  where: string,
  resultPath: string | undefined,
): void {
  if (resultPath !== undefined && !RESULT_PATH.test(resultPath)) {
    throw new Error(
      `${where}: resultPath "${resultPath}" must be "$.{key}" with a single identifier key — the context type is keyed by it, so a nested or exotic path would make downstream refs point at data that isn't there.`,
    );
  }
}

/**
 * The error object ASL places at a Catch's `ResultPath`: the error name
 * and a Cause string (for Lambda failures, a JSON-serialized stack).
 */
export interface AslCatchErrorOutput {
  Error: string;
  Cause: string;
}

/**
 * Configuration for a Catch block on a Parallel or Task state.
 *
 * @typeParam Ctx - The current builder context.
 * @typeParam Key - The key extracted from `resultPath` (e.g. `'error'` from `'$.error'`).
 *   When provided, the handler context is extended with the caught error
 *   at that key, typed as {@link AslCatchErrorOutput} — so
 *   `ctx.error.Cause` is a `Ref<string>` usable in choice conditions.
 */
export interface CatchConfig<Ctx, Key extends string = never> {
  errorEquals: AslErrorName[];
  resultPath?: `$.${Key}` & ResultPathKeyCheck<Key>;

  handler: (
    b: SequenceBuilder<Ctx & Record<Key, AslCatchErrorOutput>>,
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
// `in out`: the context is consumed (payload callbacks) and produced
// (the `_ctx` phantom), so the class is invariant — declared explicitly
// because the `Omit<Ctx, Key>` method returns put `keyof Ctx` on the
// surface, which defeats structural variance measurement and would
// otherwise break even `SequenceBuilder<Ctx>` → `SequenceBuilder<any>`.
export class SequenceBuilder<in out Ctx> {
  /** @internal Type-level only — does not exist at runtime. */
  declare readonly _ctx: Ctx;

  /** @internal */
  _states: [name: string, state: Record<string, unknown>][] = [];

  /** Create a new builder. Equivalent to `new SequenceBuilder<T>()` but chainable. */
  static create<T>(): SequenceBuilder<T> {
    return new SequenceBuilder<T>();
  }

  /**
   * @internal Copy-on-append: returns a fresh builder with the new state
   * appended, leaving this builder untouched. This is what makes builders
   * safe to reuse as shared prefixes (e.g. across parallel branches).
   */
  private append<NewCtx>(
    name: string,
    state: Record<string, unknown>,
  ): SequenceBuilder<NewCtx> {
    if (!STATE_NAME.test(name)) {
      throw new Error(
        `Invalid state name "${name}": names must be identifiers ` +
          '(letters, digits, underscores; not starting with a digit), ' +
          `since results are stored at "$.${name}" and read as ctx.${name}`,
      );
    }
    const next = new SequenceBuilder<NewCtx>();
    next._states = [...this._states, [name, state]];
    return next;
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
    P extends TypedPayloadMapping<I>,
    CatchKey extends string = never,
  >(
    name: Name,
    config: LambdaTaskConfig<I, O> & {
      resultSelector: (output: Proxied<z.infer<O>>) => R;
      resultPath: null;
      catch?: CatchConfig<Ctx, CatchKey>[];
    },
    payloadFn: (ctx: Proxied<Ctx>) => ExactPayload<I, P>,
  ): SequenceBuilder<UnwrapRefs<R>>;

  /**
   * Overload: `resultPath: null` without `resultSelector` — the full Lambda
   * output replaces the entire state input.
   */
  task<
    Name extends string,
    I extends AnyZodObject,
    O extends AnyZodObject,
    P extends TypedPayloadMapping<I>,
    CatchKey extends string = never,
  >(
    name: Name,
    config: LambdaTaskConfig<I, O> & {
      resultPath: null;
      catch?: CatchConfig<Ctx, CatchKey>[];
    } & RequireResultSelectorForOptionalOutputs<O>,
    payloadFn: (ctx: Proxied<Ctx>) => ExactPayload<I, P>,
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
    P extends TypedPayloadMapping<I>,
    CatchKey extends string = never,
  >(
    name: Name,
    config: LambdaTaskConfig<I, O> & {
      resultSelector: (output: Proxied<z.infer<O>>) => R;
      catch?: CatchConfig<Ctx, CatchKey>[];
    },
    payloadFn: (ctx: Proxied<Ctx>) => ExactPayload<I, P>,
  ): SequenceBuilder<Omit<Ctx, Name> & Record<Name, UnwrapRefs<R>>>;

  /**
   * Overload: without `resultSelector` — auto-generates a 1:1 mapping from
   * the output schema keys. The context type matches `z.infer<O>`.
   */
  task<
    Name extends string,
    I extends AnyZodObject,
    O extends AnyZodObject,
    P extends TypedPayloadMapping<I>,
    CatchKey extends string = never,
  >(
    name: Name,
    config: LambdaTaskConfig<I, O> & {
      catch?: CatchConfig<Ctx, CatchKey>[];
    } & RequireResultSelectorForOptionalOutputs<O>,
    payloadFn: (ctx: Proxied<Ctx>) => ExactPayload<I, P>,
  ): SequenceBuilder<Omit<Ctx, Name> & Record<Name, z.infer<O>>>;

  task(
    name: string,
    config: LambdaTaskConfig<AnyZodObject, AnyZodObject> & {
      resultSelector?: (output: Proxied<unknown>) => Record<string, unknown>;
      resultPath?: null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      catch?: CatchConfig<any, any>[];
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
      resultSelector = buildResultSelector(
        name,
        config.outputSchema,
        '$.Payload',
        'Pass an explicit resultSelector that only selects fields the Lambda always returns.',
      );
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

    applyTimeouts(name, state, config);

    if (config.retry) {
      state['Retry'] = config.retry;
    }

    if (config.catch) {
      (state as Record<string | symbol, unknown>)[CATCH_HANDLERS] =
        this.buildCatchEntries(config.catch);
    }

    return this.append(name, state);
  }

  /**
   * @internal Instantiate catch handler builders for a state's Catch config.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildCatchEntries(configs: CatchConfig<any, any>[]): CatchEntry[] {
    return configs.map((c) => {
      assertResultPathKey('catch handler', c.resultPath);
      return {
        errorEquals: c.errorEquals,
        resultPath: c.resultPath,
        builder: c.handler(new SequenceBuilder<Ctx>()),
      };
    });
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
    Branches extends readonly BranchInput<Ctx>[],
    CatchKey extends string = never,
  >(
    name: Name,
    branches: [...Branches],
    options?: { retry?: RetryConfig[]; catch?: CatchConfig<Ctx, CatchKey>[] },
  ): SequenceBuilder<
    Omit<Ctx, Name> & Record<Name, BranchOutputTuple<Ctx, Branches>>
  >;

  parallel(
    name: string,
    branches: BranchInput<Ctx>[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: { retry?: RetryConfig[]; catch?: CatchConfig<any, any>[] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): SequenceBuilder<any> {
    const aslBranches = branches.map((b) =>
      (typeof b === 'function' ? b(new SequenceBuilder<Ctx>()) : b).build(),
    );

    const state: Record<string, unknown> = {
      Type: 'Parallel',
      ResultPath: `$.${name}`,
      Branches: aslBranches,
    };

    if (options?.retry) {
      state['Retry'] = options.retry;
    }

    if (options?.catch) {
      (state as Record<string | symbol, unknown>)[CATCH_HANDLERS] =
        this.buildCatchEntries(options.catch);
    }

    return this.append(name, state);
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
  ): SequenceBuilder<Omit<Ctx, Name> & Record<Name, UnwrapRefs<M>>>;

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
    config: { result: R; resultPath: `$.${Key}` & ResultPathKeyCheck<Key> },
  ): SequenceBuilder<Omit<Ctx, Key> & Record<Key, R>>;

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
      assertResultPathKey(`pass "${name}"`, mappingFnOrConfig.resultPath);
      const state: Record<string, unknown> = {
        Type: 'Pass',
        Result: mappingFnOrConfig.result,
        ResultPath: mappingFnOrConfig.resultPath,
      };
      return this.append(name, state);
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

    return this.append(name, state);
  }

  /**
   * Append a Wait state to the sequence.
   *
   * Pauses execution for a fixed duration, until a fixed timestamp, or
   * for a duration/until a timestamp read from the state data. Exactly
   * one of the four options must be provided; the context type is
   * unchanged (a Wait state doesn't touch the data).
   *
   * For the `...Path` variants, use the callback form to get a typed
   * context proxy, like `task` payload callbacks.
   *
   * @example
   * ```ts
   * builder.wait('cooldown', { seconds: 30 })
   * builder.wait('untilReady', (ctx) => ({ timestampPath: ctx.job.notBefore }))
   * ```
   */
  wait(
    name: string,
    config: WaitConfig | ((ctx: Proxied<Ctx>) => WaitConfig),
  ): SequenceBuilder<Ctx> {
    const resolved =
      typeof config === 'function' ? config(createProxy<Ctx>()) : config;
    const c = resolved as {
      seconds?: number;
      timestamp?: string;
      secondsPath?: Ref<number>;
      timestampPath?: Ref<string>;
    };
    const provided = [
      c.seconds,
      c.timestamp,
      c.secondsPath,
      c.timestampPath,
    ].filter((v) => v !== undefined);
    if (provided.length !== 1) {
      throw new Error(
        `Wait state "${name}" needs exactly one of seconds, timestamp, secondsPath, timestampPath — got ${provided.length}`,
      );
    }

    const state: Record<string, unknown> = { Type: 'Wait' };
    if (c.seconds !== undefined) state['Seconds'] = c.seconds;
    if (c.timestamp !== undefined) state['Timestamp'] = c.timestamp;
    if (c.secondsPath !== undefined) {
      state['SecondsPath'] = pathOf(c.secondsPath);
    }
    if (c.timestampPath !== undefined) {
      state['TimestampPath'] = pathOf(c.timestampPath);
    }

    return this.append<Ctx>(name, state);
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
   * // Pre-built processor (ignore b); items as a typed ref selector
   * builder.map('processScenes', {
   *   items: (ctx) => ctx.scenes,
   *   itemSelector: (item, ctx) => ({ scene: item.value }),
   *   processor: () => sceneProcessor,
   * })
   *
   * // Inline processor — context inferred from selector; raw itemsPath
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
   * Overload: `items` is a typed ref selector — `items: (ctx) =>
   * ctx.scenes` gets code completion, a typo doesn't compile, and
   * `ItemType` is inferred from the ref. Preferred over `itemsPath`.
   */
  map<
    Name extends string,
    ItemType,
    S extends Record<string, unknown>,
    ProcessorCtx,
    CatchKey extends string = never,
  >(
    name: Name,
    config: MapConfig<Ctx, ItemType, S, ProcessorCtx, CatchKey> & {
      items: (ctx: Proxied<Ctx>) => Ref<readonly ItemType[]>;
      itemsPath?: undefined;
    },
  ): SequenceBuilder<Omit<Ctx, Name> & Record<Name, ProcessorCtx[]>>;

  /**
   * Overload: `itemsPath` is a string literal — `ItemType` inferred by
   * parsing the path against the context type.
   */
  map<
    Name extends string,
    ItemsPath extends string,
    S extends Record<string, unknown>,
    ProcessorCtx,
    CatchKey extends string = never,
  >(
    name: Name,
    config: MapConfig<
      Ctx,
      PathValue<Ctx, ItemsPath> extends readonly (infer I)[] ? I : never,
      S,
      ProcessorCtx,
      CatchKey
    > & {
      itemsPath: ItemsPath;
      items?: undefined;
    },
  ): SequenceBuilder<Omit<Ctx, Name> & Record<Name, ProcessorCtx[]>>;

  map<
    Name extends string,
    ItemType,
    S extends Record<string, unknown>,
    ProcessorCtx,
    CatchKey extends string = never,
  >(
    name: Name,
    config: MapConfig<Ctx, ItemType, S, ProcessorCtx, CatchKey>,
  ): SequenceBuilder<Omit<Ctx, Name> & Record<Name, ProcessorCtx[]>>;

  map(
    name: string,
    // Broad structural type: generic Omit intersections defeat the
    // overload-compatibility check, so the impl spells the fields out.
    config: {
      itemsPath?: string;
      items?: (ctx: Proxied<Ctx>) => Ref<readonly unknown[]>;
      maxConcurrency?: number;
      retry?: RetryConfig[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      catch?: CatchConfig<any, any>[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      itemSelector: (item: any, ctx: any) => Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      processor: (b: any) => SequenceBuilder<any>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): SequenceBuilder<any> {
    const outerProxy = createProxy<Ctx>();

    // Resolve the items source before running the selector/processor
    // callbacks, so a misconfiguration surfaces as this error rather
    // than whatever those callbacks happen to throw first.
    let itemsPath: string;
    if (config.items) {
      const ref = config.items(outerProxy);
      if (!isRef(ref)) {
        throw new Error(
          `Map state "${name}": items must return a typed ref from the context (e.g. (ctx) => ctx.scenes). For a raw JSONPath string, use itemsPath instead.`,
        );
      }
      itemsPath = pathOf(ref);
    } else if (config.itemsPath !== undefined) {
      itemsPath = config.itemsPath;
    } else {
      throw new Error(
        `Map state "${name}" needs either items (a typed ref selector) or itemsPath`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemProxy = createMapItemProxy<any>();
    const selectorMapping = config.itemSelector(itemProxy, outerProxy);
    const itemSelector = serializeParameters(selectorMapping);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = config.processor(new SequenceBuilder<any>());
    const built = processor.build();

    const state: Record<string, unknown> = {
      Type: 'Map',
      ItemsPath: itemsPath,
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

    if (config.retry) {
      state['Retry'] = config.retry;
    }

    if (config.catch) {
      (state as Record<string | symbol, unknown>)[CATCH_HANDLERS] =
        this.buildCatchEntries(config.catch);
    }

    return this.append(name, state);
  }

  /**
   * Append a custom (non-Lambda) Task state to the sequence.
   *
   * Use this for resources like AWS Batch (`batch:submitJob`), SNS, SQS, etc.
   * The parameters callback supports refs and intrinsic functions at any
   * nesting depth.
   *
   * The context follows the ASL semantics of `ResultPath`, not the state
   * name: with `resultPath: '$.transcodeJob'` the result is available as
   * `ctx.transcodeJob`; with no `resultPath`, the result replaces the
   * entire state input and the context becomes the task's output alone.
   * Pass `outputSchema` to type that output — exactly like `task`, it
   * generates a `ResultSelector` projecting each schema key from the raw
   * result, so the typed context matches what actually lands in the data
   * (and optional fields are rejected, since the selector references
   * every key).
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
   *   outputSchema: z.object({ JobId: z.string() }),
   * })
   * // ctx.transcodeJob.JobId: string
   * ```
   */

  /** Overload: `resultPath` + `outputSchema` — typed result at `ctx.{key}`. */
  customTask<
    OSchema extends AnyZodObject,
    Key extends string,
    CatchKey extends string = never,
  >(
    name: string,
    config: CustomTaskConfig<Ctx, CatchKey> & {
      resultPath: `$.${Key}` & ResultPathKeyCheck<Key>;
      outputSchema: OSchema;
    } & RequireNoOptionalOutputs<OSchema>,
  ): SequenceBuilder<Omit<Ctx, Key> & Record<Key, z.infer<OSchema>>>;

  /** Overload: `resultPath` only — untyped result at `ctx.{key}`. */
  customTask<Key extends string, CatchKey extends string = never>(
    name: string,
    config: CustomTaskConfig<Ctx, CatchKey> & {
      resultPath: `$.${Key}` & ResultPathKeyCheck<Key>;
      outputSchema?: undefined;
    },
  ): SequenceBuilder<Omit<Ctx, Key> & Record<Key, Record<string, unknown>>>;

  /** Overload: no `resultPath` — the typed output replaces the input. */
  customTask<OSchema extends AnyZodObject, CatchKey extends string = never>(
    name: string,
    config: CustomTaskConfig<Ctx, CatchKey> & {
      resultPath?: undefined;
      outputSchema: OSchema;
    } & RequireNoOptionalOutputs<OSchema>,
  ): SequenceBuilder<z.infer<OSchema>>;

  /** Overload: no `resultPath`, no schema — untyped replacement. */
  customTask<CatchKey extends string = never>(
    name: string,
    config: CustomTaskConfig<Ctx, CatchKey> & {
      resultPath?: undefined;
      outputSchema?: undefined;
    },
  ): SequenceBuilder<Record<string, unknown>>;

  customTask(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: CustomTaskConfig<Ctx, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): SequenceBuilder<any> {
    assertResultPathKey(`customTask "${name}"`, config.resultPath);

    const proxy = createProxy<Ctx>();
    const rawParams = config.parameters(proxy);
    const parameters = serializeParameters(rawParams);

    const state: Record<string, unknown> = {
      Type: 'Task',
      Resource: config.resource,
      Parameters: parameters,
    };

    if (config.outputSchema) {
      state['ResultSelector'] = buildResultSelector(
        name,
        config.outputSchema,
        '$',
        'List only fields the service always returns, or drop outputSchema for an untyped result.',
      );
    }

    if (config.resultPath !== undefined) {
      state['ResultPath'] = config.resultPath;
    }

    applyTimeouts(name, state, config);

    if (config.retry) {
      state['Retry'] = config.retry;
    }

    if (config.catch) {
      (state as Record<string | symbol, unknown>)[CATCH_HANDLERS] =
        this.buildCatchEntries(config.catch);
    }

    return this.append(name, state);
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
    return this.append(name, state);
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

    return this.append<Ctx>(name, state);
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
    return this.append<Ctx>(name, { Type: 'Succeed' });
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

    // States are keyed by their capitalized name, so two states whose names
    // differ only in first-letter case would silently overwrite each other.
    const addState = (stateName: string, s: object): void => {
      if (states[stateName]) {
        throw new Error(`Duplicate state name "${stateName}"`);
      }
      states[stateName] = s;
    };

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
        // and the implicit default converge on an auto-generated Pass end
        // state. (If a parent builder later appends states after this choice,
        // rewireTerminals redirects that Pass to the real next state.)
        let endPassStateName: string | undefined;
        const getOrCreateEndPass = (): string => {
          if (!endPassStateName) {
            endPassStateName = `${capitalize(name)}End`;
            addState(endPassStateName, { Type: 'Pass', End: true });
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

        addState(capitalize(name), choiceState);
        continue;
      }

      // ── Terminal states (Fail / Succeed) ────────────────────────
      if (state['Type'] === 'Fail' || state['Type'] === 'Succeed') {
        if (!isLast) {
          // Nothing can follow a terminal state — the states after it
          // would be unreachable, which AWS rejects at creation time.
          throw new Error(
            `Terminal state "${capitalize(name)}" must be the last state ` +
              'in its sequence — the states after it would be unreachable',
          );
        }
        addState(capitalize(name), { ...state });
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

      // Handle Catch handlers (Task, Parallel, and Map states)
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

      addState(capitalize(name), copy);
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
  if (isRef(item) || isIntrinsic(item)) {
    // ASL only substitutes JSONPaths in object keys ending in ".$" — a path
    // string as a plain array element would reach the state as a literal.
    throw new Error(
      'A ref or intrinsic cannot be used directly as an array element — ' +
        'ASL has no path substitution inside arrays. ' +
        'Use statesArray(...) to build the array instead.',
    );
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
 * - Recurses into nested objects and arrays (same rules as
 *   `serializeParameters`), so refs at any depth become path entries
 * - Keeps static values as `"key": value`
 * - Skips `undefined` values (optional schema fields can be omitted)
 */
/**
 * Serialize `TimeoutConfig` options onto a Task state, enforcing that the
 * static and `...Path` variants of each option are mutually exclusive —
 * ASL rejects a state carrying both.
 */
function applyTimeouts(
  name: string,
  state: Record<string, unknown>,
  config: TimeoutConfig,
): void {
  if (config.timeoutSeconds !== undefined && config.timeoutSecondsPath) {
    throw new Error(
      `Task "${name}" has both timeoutSeconds and timeoutSecondsPath — they are mutually exclusive`,
    );
  }
  if (config.heartbeatSeconds !== undefined && config.heartbeatSecondsPath) {
    throw new Error(
      `Task "${name}" has both heartbeatSeconds and heartbeatSecondsPath — they are mutually exclusive`,
    );
  }
  if (config.timeoutSeconds !== undefined) {
    state['TimeoutSeconds'] = config.timeoutSeconds;
  }
  if (config.timeoutSecondsPath) {
    state['TimeoutSecondsPath'] = pathOf(config.timeoutSecondsPath);
  }
  if (config.heartbeatSeconds !== undefined) {
    state['HeartbeatSeconds'] = config.heartbeatSeconds;
  }
  if (config.heartbeatSecondsPath) {
    state['HeartbeatSecondsPath'] = pathOf(config.heartbeatSecondsPath);
  }
}

/**
 * The shape of a Zod 4 schema's `def`, restricted to the slice this
 * module inspects. Kept structural so we don't depend on Zod's internal
 * class hierarchy.
 */
type UnknownZodDef = {
  type?: string;
  catchall?: unknown;
  innerType?: unknown;
  element?: unknown;
  shape?: Record<string, unknown>;
};

/**
 * Get a schema's `def`, unwrapping optional/nullable/default wrappers so
 * `z.object({...}).optional()` still reads as an object def.
 */
function unwrapZodDef(schema: unknown): UnknownZodDef | undefined {
  let def = (schema as { def?: UnknownZodDef } | undefined)?.def;
  while (
    def &&
    (def.type === 'optional' ||
      def.type === 'nullable' ||
      def.type === 'default')
  ) {
    def = (def.innerType as { def?: UnknownZodDef } | undefined)?.def;
  }
  return def;
}

/**
 * The runtime half of `NoExtraPayloadKeys`, for callers outside the type
 * system: reject payload keys the input schema does not know about, since
 * an extra key is almost always a typo'd field the Lambda will never
 * validate. Recurses into nested object fields and object array elements.
 *
 * Deliberate tolerances:
 * - Schemas that accept unknown keys (`looseObject`, `.catchall(...)`) are
 *   honored — no throw at that level.
 * - `undefined` values are skipped: they are never serialized, so nothing
 *   reaches the Lambda.
 * - Refs and intrinsics resolve at execution time and cannot be inspected.
 */
function assertNoExtraPayloadKeys(
  schema: unknown,
  payload: Record<string, unknown>,
  path: string,
): void {
  const objectDef = unwrapZodDef(schema);
  if (objectDef?.type !== 'object' || !objectDef.shape) return;

  const catchallType = objectDef.catchall
    ? unwrapZodDef(objectDef.catchall)?.type
    : undefined;
  const acceptsUnknownKeys =
    catchallType !== undefined && catchallType !== 'never';

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(objectDef.shape, key)) {
      if (acceptsUnknownKeys) continue;
      throw new Error(
        `Payload field "${path}${key}" is not in the input schema — it would be sent to the Lambda but never validated. Remove it or add it to the schema.`,
      );
    }
    if (isRef(value) || isIntrinsic(value)) continue;

    const fieldSchema = objectDef.shape[key];
    if (Array.isArray(value)) {
      const fieldDef = unwrapZodDef(fieldSchema);
      if (fieldDef?.type === 'array' && fieldDef.element) {
        for (const [i, item] of value.entries()) {
          if (
            item !== null &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            !isRef(item) &&
            !isIntrinsic(item)
          ) {
            assertNoExtraPayloadKeys(
              fieldDef.element,
              item as Record<string, unknown>,
              `${path}${key}[${i}].`,
            );
          }
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      assertNoExtraPayloadKeys(
        fieldSchema,
        value as Record<string, unknown>,
        `${path}${key}.`,
      );
    }
  }
}

function buildAslPayload(
  inputSchema: AnyZodObject,
  mappedPayload: Record<string, unknown>,
): Record<string, unknown> {
  assertNoExtraPayloadKeys(inputSchema, mappedPayload, '');

  const aslPayload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(mappedPayload)) {
    if (value === undefined) continue;
    if (isRef(value)) {
      aslPayload[`${key}.$`] = pathOf(value);
    } else if (isIntrinsic(value)) {
      aslPayload[`${key}.$`] = getExpression(value);
    } else if (Array.isArray(value)) {
      aslPayload[key] = value.map((item) => serializeItem(item));
    } else if (typeof value === 'object' && value !== null) {
      aslPayload[key] = serializeParameters(value as Record<string, unknown>);
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
 *
 * A schema with `.optional()` fields is rejected: the generated selector
 * references every key, and ASL errors at runtime when a referenced key
 * is absent. Such schemas must pass an explicit `resultSelector` (also
 * enforced at compile time by `RequireResultSelectorForOptionalOutputs`).
 */
function buildResultSelector(
  stateName: string,
  outputSchema: AnyZodObject,
  resultPrefix: string,
  optionalFieldAdvice: string,
): Record<string, string> {
  const optionalKeys = Object.entries(
    outputSchema.shape as Record<string, unknown>,
  )
    .filter(
      ([, field]) =>
        (field as { def?: { type?: string } }).def?.type === 'optional',
    )
    .map(([key]) => key);
  if (optionalKeys.length > 0) {
    throw new Error(
      `Task "${stateName}": output schema field(s) ${optionalKeys.join(', ')} are optional, but the auto-generated ResultSelector references every key and ASL errors at runtime when one is absent. ${optionalFieldAdvice}`,
    );
  }

  const selector: Record<string, string> = {};
  for (const key of Object.keys(outputSchema.shape)) {
    selector[`${key}.$`] = `${resultPrefix}.${key}`;
  }
  return selector;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

import { z } from 'zod';

import { createProxy, isRef, pathOf } from './proxy.js';
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
    const resultSelector = buildResultSelector(config.outputSchema);

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
   * context or static values. The result is stored at `$.{name}`.
   *
   * @param name - State name and context key for the pass result.
   * @param mappingFn - Callback that maps the current context to the
   *   output parameters. Ref values become JSONPath entries, static
   *   values are kept as-is.
   * @returns A new builder whose context includes the pass output
   *   keyed by `name`.
   *
   * @example
   * ```ts
   * builder.pass('filterOutput', ctx => ({
   *   sceneIndex: ctx.scene.id,
   *   videoId: ctx.createVideoAssetForScene.videoId,
   * }))
   * ```
   */
  pass<Name extends string, M extends Record<string, unknown>>(
    name: Name,
    mappingFn: (ctx: Proxied<Ctx>) => M
  ): SequenceBuilder<Ctx & Record<Name, UnwrapRefs<M>>> {
    const proxy = createProxy<Ctx>();
    const mapped = mappingFn(proxy);

    const parameters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mapped)) {
      if (isRef(value)) {
        parameters[`${key}.$`] = pathOf(value);
      } else {
        parameters[key] = value;
      }
    }

    const state: Record<string, unknown> = {
      Type: 'Pass',
      ResultPath: `$.${name}`,
      Parameters: parameters,
    };

    this._states.push([name, state]);

    return this as unknown as SequenceBuilder<
      Ctx & Record<Name, UnwrapRefs<M>>
    >;
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
        copy['Next'] = this._states[i + 1][0];
      }

      states[name] = copy;
    }

    return {
      ...(options?.comment ? { Comment: options.comment } : {}),
      StartAt: this._states[0][0],
      States: states,
    };
  }
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Build the ASL Payload object from a typed payload mapping.
 *
 * - Extracts the `step` literal from the input schema and adds it
 * - Converts Ref values to `"key.$": "$.path"` JSONPath entries
 * - Keeps static values as `"key": value`
 */
function buildAslPayload(
  inputSchema: AnyZodObject,
  mappedPayload: Record<string, unknown>
): Record<string, unknown> {
  const aslPayload: Record<string, unknown> = {};

  const stepValue = extractStepLiteral(inputSchema);
  if (stepValue !== undefined) {
    aslPayload['step'] = stepValue;
  }

  for (const [key, value] of Object.entries(mappedPayload)) {
    if (isRef(value)) {
      aslPayload[`${key}.$`] = pathOf(value);
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
 * Extract the string literal value from a schema's `step` field.
 *
 * Supports Zod 4's internal representation (`_zod.def.values` as an array)
 * and Zod 3's `.value` property as a fallback.
 */
function extractStepLiteral(schema: AnyZodObject): string | undefined {
  const stepField = schema.shape.step;
  if (!stepField) return undefined;

  // Zod 4: literal schemas store values in _zod.def.values (array)
  const zod = (
    stepField as unknown as {
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
    'value' in stepField &&
    typeof (stepField as unknown as { value: unknown }).value === 'string'
  ) {
    return (stepField as unknown as { value: string }).value;
  }

  return undefined;
}

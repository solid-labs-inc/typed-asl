# @stellar/step

Type-safe AWS Step Functions builder. Generates ASL (Amazon States Language) JSON from TypeScript with compile-time validation that payload mappings match Zod schemas, JSONPath refs resolve to real upstream outputs, and ref types are correct.

## Why

Step function definitions (`.json.tftpl` files) and Lambda handler schemas were completely disconnected. Misaligned payloads, dangling JSONPath references, and type mismatches were only caught at runtime. This package closes that gap — if it typechecks, the payloads are correct.

See [step_functions_refactor.md](./step_functions_refactor.md) for the full design rationale.

## Quick start

```ts
import { SequenceBuilder } from '@stellar/step';

type Input = { bucket: string; key: string };

const machine = new SequenceBuilder<Input>()
  .task('runMediaInfo', {
    inputSchema: RunMediainfoStepInput,
    outputSchema: RunMediainfoStepOutput,
    functionArn: LAMBDA_ARN,
  }, ctx => ({
    bucket: ctx.bucket,   // Ref<string> — resolved at compile time
    key: ctx.key,
  }))
  .task('createVideo', {
    inputSchema: CreateVideoInput,
    outputSchema: CreateVideoOutput,
    functionArn: LAMBDA_ARN,
  }, ctx => ({
    mediaInfo: ctx.runMediaInfo.mediaInfo,  // typed ref to upstream output
  }))
  .build();
```

`machine` is an `AslStateMachine` (`{ StartAt, States }`) ready to be JSON-serialized into a Terraform template.

## What it catches at compile time

| Bug | Caught? |
|-----|---------|
| Missing required payload field | Yes |
| Extra payload field not in schema | Yes |
| Ref to nonexistent state output (`ctx.doesNotExist.foo`) | Yes |
| Ref to nonexistent field (`ctx.extractFrames.nonexistent`) | Yes |
| Ref type mismatch (`Ref<number>` where `StorageRef[]` expected) | Yes |
| Wrong parallel branch index (`ctx.process[2]` when only 2 branches) | Yes |

## Architecture

```
src/
├── index.ts          # Barrel re-exports
└── lib/
    ├── types.ts      # Ref<T>, Proxied<T>, TypedPayloadMapping
    ├── proxy.ts      # createProxy(), pathOf(), isRef(), createMapItemProxy()
    ├── intrinsic.ts  # statesFormat(), statesJsonToString(), IntrinsicExpr
    ├── builder.ts    # SequenceBuilder, retry presets, config types
    ├── proxy.test.ts
    ├── types.test.ts
    └── builder.test.ts
```

### types.ts — Core type system

- **`REF_PATH`** — Symbol key storing JSONPath segments on proxy objects.
- **`Ref<T>`** — Branded type: carries a phantom type `T` and a runtime path array. Every proxy property access produces a `Ref`.
- **`Proxied<T>`** — Recursive mapped type wrapping every property (including tuple indices) as `Proxied<PropertyType>`. Also extends `Ref<T>`, so a proxy can be used directly as a reference.
- **`TypedPayloadMapping<T>`** — For each Zod schema field (excluding `step`/`task` discriminators), accepts `z.infer<Field> | Ref<z.infer<Field>>`. This is what enforces payload correctness.

### proxy.ts — Runtime path recording

- **`createProxy<T>(path?)`** — Returns a `Proxied<T>` JavaScript Proxy that records every property access as a JSONPath segment. Numeric keys become `[n]` segments.
- **`pathOf(ref)`** — Converts a Ref's path segments to a JSONPath string (e.g. `$.processScene[0].extractFrames.output`). Handles both `$` and `$$` roots.
- **`isRef(value)`** — Type guard checking for the `REF_PATH` symbol.
- **`createMapItemProxy<T>()`** — Creates `$$`-rooted proxies for Map state iteration: `item.value` (`$$.Map.Item.Value`) and `item.index` (`$$.Map.Item.Index`).

### intrinsic.ts — Step Functions intrinsic functions

- **`IntrinsicExpr<T>`** — Branded type for intrinsic expressions (e.g. `States.Format(...)`). Carries a phantom result type `T`.
- **`statesFormat(template, ...args)`** — Produces `States.Format('template', ref1, ref2)`. Arguments can be `Ref` or other `IntrinsicExpr` values.
- **`statesJsonToString(ref)`** — Produces `States.JsonToString($.path)`.
- **`isIntrinsic(value)` / `getExpression(expr)`** — Type guard and expression extractor.

### builder.ts — SequenceBuilder

The main API. Each method appends a state and returns a new builder with an expanded context type.

#### `task(name, config, payloadFn)`

Appends a Lambda Task state. Auto-generates:
- `Parameters.Payload` with the discriminator literal (`step` or `task`) extracted from the input schema, refs as `"key.$": "$.path"`, static values as-is
- `ResultSelector` mapping each output schema key to `$.Payload.{key}` (overridable via `config.resultSelector`)
- Optional `Retry` config

Returns `SequenceBuilder<Ctx & Record<Name, z.infer<OutputSchema>>>`.

#### `parallel(name, branches)`

Appends a Parallel state. Each branch is a `SequenceBuilder` starting from the current context. The result is a **tuple type** — `ctx.parallel[0]` is branch 0's output type, not a union.

Key type machinery:
- `BranchOutputTuple<Base, Branches>` — Mapped tuple type extracting each branch's delta output via `Omit<Full, keyof Base>`
- `[...Branches]` variadic tuple parameter forces tuple inference (without it TypeScript infers `SequenceBuilder<any>[]`)
- `declare readonly _ctx: Ctx` phantom property enables reliable type extraction via `infer`

#### `pass(name, mappingFn, options?)`

Appends a Pass state for reshaping data without invoking a Lambda.
- `UnwrapRefs<M>` maps `Ref<T>` to `T` for the output type
- `options.resultPath: null` omits `ResultPath` (output replaces entire state input)

#### `map(name, config)`

Appends a Map state iterating over an array.
- `itemSelector` receives `MapItemRef<T>` (typed `$$` proxies) and the outer `Proxied<Ctx>`
- Supports intrinsic functions in selector values
- `processor` is a pre-built `AslStateMachine` used as an inline `ItemProcessor`

#### `customTask(name, config)`

Appends a non-Lambda Task state (e.g. AWS Batch `submitJob`, SNS, SQS).
- `parameters` callback supports refs and intrinsic functions at any nesting depth via recursive `serializeParameters()`

#### `pipe(fn)`

Applies a transform function to the builder, enabling reusable task definitions while keeping a flat chain. The function receives the current builder and returns a new one with an expanded context.

```ts
// Define a reusable task as a generic function.
// The constraint declares what upstream outputs it requires.
const addCreateAtlas = <Ctx extends { extractFrames: { frameStorageRefs: StorageRef[] } }>(
  b: SequenceBuilder<Ctx>
) => b.task('createAtlas', createAtlasConfig, ctx => ({
  frameStorageRefs: ctx.extractFrames.frameStorageRefs,
  outputFilename: 'atlas.webp',
}));

// Use it inline — reads as part of the chain, not a wrapper
new SequenceBuilder<Input>()
  .task('extractFrames', extractConfig, ctx => ({ ... }))
  .pipe(addCreateAtlas)
  .task('finalize', finalizeConfig, ctx => ({
    atlas: ctx.createAtlas.atlasStorageRef,  // output is in context
  }))
  .build();
```

The piped function can append multiple states, use `.parallel()`, or even `.pipe()` again. Context flows through exactly as if the states were inlined.

#### `build(options?)`

Wires up `Next`/`End` pointers and returns `{ StartAt, States, Comment? }`.

### Retry presets

- **`DEFAULT_RETRY`** — `States.ALL`, 3 attempts, 2s interval, 2x backoff
- **`THROTTLE_RETRY`** — `ThrottlingException` + `Lambda.TooManyRequestsException` (10 attempts), then `DEFAULT_RETRY`

### Serialization helpers

- **`serializeParameters(obj)`** — Recursively converts a parameters object: `Ref` → `"key.$": "$.path"`, `IntrinsicExpr` → `"key.$": "States.Format(...)"`, nested objects recursed, primitives kept as-is. Exported for use in custom scenarios.

## How context accumulation works

Each builder method returns the same builder instance cast to a wider context type. Starting from `SequenceBuilder<Input>`:

```
.task('a', ...)  → SequenceBuilder<Input & { a: OutputA }>
.task('b', ...)  → SequenceBuilder<Input & { a: OutputA } & { b: OutputB }>
.parallel('p', [branch0, branch1])
                 → SequenceBuilder<... & { p: [Branch0Delta, Branch1Delta] }>
```

The `payloadFn` callback receives `Proxied<Ctx>` at each step, so `ctx.a.someField` is a `Ref<FieldType>` that TypeScript validates against the schema.

## How parallel tuple types work

A Parallel state in ASL produces an array where index 0 is branch 0's output. A plain `Array<Union>` loses per-index types. The solution:

1. Each branch is a `SequenceBuilder` with a fully-typed `_ctx` phantom field
2. `BranchOutputTuple` is a mapped tuple type: `{ [I in keyof Branches]: Omit<Full, keyof Base> }`
3. TypeScript's mapped tuple rule preserves per-index types, so `ctx.parallel[0]` resolves to branch 0's specific output, not a union

## Zod compatibility

Uses **Zod 4**. Literal discriminator values are extracted via `_zod.def.values` (an array). Falls back to Zod 3's `.value` property.

## Commands

```bash
nx test step         # Run tests (vitest)
nx typecheck step    # Type-check
```

## Tests

78 tests across three files:
- **proxy.test.ts** — Path recording, numeric indices, `isRef`, `pathOf`
- **types.test.ts** — `TypedPayloadMapping` accepts/rejects correct/wrong types
- **builder.test.ts** — State generation, payload mapping, result selectors, retry config, parallel branches, pass reshaping, pipe reuse, map states, custom tasks, intrinsic functions, full extraction step function end-to-end test

# Step Functions Type-Safe Builder — Refactor Plan

## Problem

The step function definitions (`.json.tftpl` files) and the TypeScript Lambda handlers (`asset-ingestion-step`) have completely disconnected contracts. The Terraform JSON templates manually specify payloads and result selectors with no compile-time validation against the Zod schemas the handlers use. Misalignment is discovered only at runtime when a step function execution fails.

## Approach Options (ascending type-safety)

### Option A: Typed payload fields + untyped ref strings (pragmatic)

A `lambdaStep()` function that accepts Zod input/output schemas and ensures every required field has a mapping. JSONPath references remain opaque strings (`ref('$.extractFrames.frameStorageRefs')`). Constants for output paths reduce typos.

- Catches: missing fields, extra fields, wrong step literals
- Does not catch: invalid JSONPath references, type mismatches on refs
- Effort: ~200 lines of builder code
- Covers ~80% of real bugs

### Option B: Option A + CI linter

Same as A, plus a build-time validation script that walks the generated ASL and checks every `"key.$"` reference resolves to a `resultPath` + `resultSelector` key defined by an upstream state.

- Catches: everything in A, plus dangling refs
- Does not catch: type mismatches on refs (e.g. passing `number` where `StorageRef[]` is expected)
- Effort: ~400 lines total

### Option C: Full type-safety with proxy-based refs (maximum safety)

A builder that tracks the state machine's data flow at the TypeScript type level. Instead of string JSONPaths, payload mappings use `ctx => ctx.extractFrames.frameStorageRefs` where `ctx` is a typed Proxy. Every ref is validated for existence AND type correctness at compile time.

- Catches: all of the above, plus type mismatches on refs
- Effort: ~500-1000 lines of builder infrastructure
- Tradeoff: advanced TypeScript (recursive conditionals, tuple manipulation, Proxies), potentially cryptic error messages

---

## Option C — Full Design

### Core Types

#### `Ref<T>`: A branded reference carrying type and path

```typescript
const REF_PATH = Symbol('refPath');

type Ref<T> = {
  readonly [REF_PATH]: string[];
  readonly __refType: T;
};
```

#### `Proxied<T>`: Wraps every property so access returns `Ref<PropertyType>`

```typescript
type Proxied<T> =
  Ref<T> & {
    readonly [K in keyof T]-?: Proxied<T[K]>;
  } & (T extends readonly (infer U)[]
    ? { readonly [n: number]: Proxied<U> }
    : unknown);
```

#### Runtime proxy that records property access as JSONPath segments

```typescript
function createProxy<T>(path: string[] = ['$']): Proxied<T> {
  return new Proxy(Object.create(null), {
    get(_, prop: string | symbol) {
      if (prop === REF_PATH) return path;
      if (typeof prop === 'symbol') return undefined;
      const segment = /^\d+$/.test(prop) ? `[${prop}]` : prop;
      return createProxy([...path, segment]);
    },
  }) as Proxied<T>;
}

function pathOf(ref: Ref<unknown>): string {
  const segments = ref[REF_PATH];
  return segments.reduce((acc, seg) =>
    seg.startsWith('[') ? `${acc}${seg}` : acc === '$' ? `$.${seg}` : `${acc}.${seg}`
  );
}
```

#### Typed payload mapping

For each schema field (except `step`), accept either a static value of the correct type or a `Ref<T>` where `T` matches:

```typescript
type TypedPayloadMapping<S extends z.ZodRawShape> = {
  [K in Exclude<keyof S, 'step'>]: z.infer<S[K]> | Ref<z.infer<S[K]>>;
};
```

### `SequenceBuilder<Ctx>`: Context accumulation

Each method returns a new builder with an expanded context type:

```typescript
class SequenceBuilder<Ctx> {
  task<
    Name extends string,
    I extends z.ZodObject<z.ZodRawShape>,
    O extends z.ZodObject<z.ZodRawShape>,
  >(
    name: Name,
    config: {
      inputSchema: I;
      outputSchema: O;
      functionArn: string;
      retry?: object[];
    },
    payloadFn: (ctx: Proxied<Ctx>) => TypedPayloadMapping<Shape<I>>,
    resultPath: `$.${Name}`,
  ): SequenceBuilder<Ctx & Record<Name, z.infer<O>>> {
    // 1. Create proxy for ctx
    // 2. Call payloadFn(proxy) to get mapped payload
    // 3. Convert Ref values → JSONPath strings in ASL output
    // 4. Return new builder with expanded Context type
  }

  parallel<Name extends string, Branches extends readonly BranchDef[]>(
    name: Name,
    branches: [...Branches],
    resultPath: `$.${Name}`,
  ): SequenceBuilder<Ctx & Record<Name, BranchOutputTuple<Branches>>> {
    // Context gains: { [Name]: [Branch0Output, Branch1Output, ...] }
  }

  build(): Record<string, object> {
    // Wire up Next/End pointers, return ASL states object
  }
}
```

#### Parallel output type: tuple, not array

The core challenge: a Parallel state in ASL produces an **array** where element 0 is branch 0's output, element 1 is branch 1's, etc. A plain `Array<SomeUnion>` loses which branch is at which index. We need TypeScript to understand that `ctx.processScene[0]` is specifically branch 0's output type, not a union of all branches.

The solution is to make the parallel method preserve **tuple types** through its generic signature, then use mapped tuple types to extract each branch's output.

##### Step 1: `BranchDef` — each branch carries its output type

A `BranchDef` wraps a `SequenceBuilder` and captures the type it produces. The `Output` generic is the intersection of all state outputs that the branch's sequence accumulates:

```typescript
/**
 * Represents one branch of a Parallel state.
 * Output is the accumulated context type from all states in this branch
 * (minus the initial context, which is shared across branches).
 */
type BranchDef<InitialCtx = unknown, Output = unknown> = {
  builder: SequenceBuilder<InitialCtx & Output>;
  /** Phantom type — only exists at the type level */
  __outputType: Output;
};

/**
 * Helper to create a BranchDef from a SequenceBuilder.
 * Infers the Output by subtracting the initial context from the
 * builder's accumulated context.
 *
 * Given: SequenceBuilder<SceneIterationContext & { extractFrames: ExtractOutput }>
 * InitialCtx = SceneIterationContext
 * Output = { extractFrames: ExtractOutput }
 */
function defineBranch<InitialCtx, FullCtx extends InitialCtx>(
  _initialCtx: InitialCtx, // only used for type inference, not at runtime
  builder: SequenceBuilder<FullCtx>,
): BranchDef<InitialCtx, Omit<FullCtx, keyof InitialCtx>> {
  return {
    builder: builder as any,
    __outputType: undefined as any, // phantom
  };
}
```

##### Step 2: `BranchOutputTuple` — mapped type over a tuple

This is the type that converts `[BranchDef<Ctx, A>, BranchDef<Ctx, B>]` into `[A, B]`:

```typescript
/**
 * Given a tuple of BranchDefs, extract a tuple of their Output types.
 *
 * Example:
 *   BranchOutputTuple<[BranchDef<Ctx, { frames: FramesOut }>, BranchDef<Ctx, { preview: PreviewOut }>]>
 *   = [{ frames: FramesOut }, { preview: PreviewOut }]
 *
 * This is a MAPPED TUPLE TYPE — TypeScript preserves tuple structure
 * when you map over `keyof T` where T is a tuple. The keys of a tuple
 * are '0', '1', '2', etc., so the mapped type produces another tuple.
 */
type BranchOutputTuple<T extends readonly BranchDef<any, any>[]> = {
  [I in keyof T]: T[I] extends BranchDef<any, infer O> ? O : never;
};
```

Why this produces a tuple and not an object with numeric keys: TypeScript has special handling for mapped types over tuple/array types. When `T` is `[A, B, C]`, `{ [I in keyof T]: F<T[I]> }` produces `[F<A>, F<B>, F<C>]` — a tuple, not `{ 0: F<A>, 1: F<B>, 2: F<C> }`.

##### Step 3: The `parallel()` method signature

The method uses `[...Branches]` (variadic tuple type) to force TypeScript to infer a tuple rather than an array:

```typescript
class SequenceBuilder<Ctx> {
  parallel<
    Name extends string,
    Branches extends readonly BranchDef<Ctx, any>[],
  >(
    name: Name,
    branches: [...Branches],
    //        ^^^^^^^^^^^^^ variadic tuple — forces tuple inference
    resultPath: `$.${Name}`,
  ): SequenceBuilder<Ctx & Record<Name, BranchOutputTuple<Branches>>> {
    //                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    // Context gains: { [Name]: [Branch0Output, Branch1Output, ...] }

    // Runtime: build the ASL Parallel state
    const aslBranches = branches.map(b => {
      const states = b.builder.build();
      const startAt = Object.keys(states)[0];
      return { StartAt: startAt, States: states };
    });

    this.addState(name, {
      Type: 'Parallel',
      Branches: aslBranches,
      ResultPath: resultPath,
    });

    return this as unknown as SequenceBuilder<
      Ctx & Record<Name, BranchOutputTuple<Branches>>
    >;
  }
}
```

Without `[...Branches]`, TypeScript would infer `Branches` as `BranchDef<any, any>[]` (an array), and `BranchOutputTuple` would produce `unknown[]` — losing all per-index type information. The variadic tuple forces inference of the exact tuple type.

##### Step 4: How it flows through `Proxied<T>`

When the context type is:
```typescript
type Ctx = SceneIterationContext & {
  processScene: [
    { extractFramesForScene: ExtractFramesOutput; generateDescriptionsForScene: [ImgEmbedOut, TextEmbedOut, AtlasOut] },
    { transcodePreviewForScene: TranscodePreviewOutput }
  ]
}
```

The proxy type resolves each access:

```
ctx.processScene          → Proxied<[Branch0, Branch1]>        // tuple
ctx.processScene[0]       → Proxied<Branch0>                   // first element
ctx.processScene[0].generateDescriptionsForScene
                          → Proxied<[ImgEmbedOut, TextEmbedOut, AtlasOut]>  // nested tuple
ctx.processScene[0].generateDescriptionsForScene[2]
                          → Proxied<AtlasOut>                  // AtlasOut specifically
ctx.processScene[0].generateDescriptionsForScene[2].createAtlasForScene
                          → Proxied<CreateAtlasForSceneOutput>
ctx.processScene[0].generateDescriptionsForScene[2].createAtlasForScene.thumbnailStorageRef
                          → Proxied<StorageRef>                // Ref<StorageRef> ✅
```

This works because `Proxied<T>` includes `{ readonly [n: number]: Proxied<U> }` for array/tuple types. For tuples, TypeScript's indexing rules mean `[A, B, C][0]` resolves to `A`, not `A | B | C`.

At **runtime**, the Proxy records the path: `['$', 'processScene', '[0]', 'generateDescriptionsForScene', '[2]', 'createAtlasForScene', 'thumbnailStorageRef']`, which `pathOf()` converts to `"$.processScene[0].generateDescriptionsForScene[2].createAtlasForScene.thumbnailStorageRef"`.

##### Step 5: Nested parallel — full worked example

Here's the complete type flow for the extraction step function's scene processor:

```typescript
// Initial context for each Map iteration
type C0 = SceneIterationContext;

// Branch 0 of processScene:
//   extractFramesForScene → parallel(generateDescriptionsForScene)
type ExtractFramesOut = { frameStorageRefs: StorageRef[]; width: number; height: number };
type ImgEmbedOut = { embedding: number[] };
type TextEmbedOut = { description: string; objects: string[]; text: string[]; colors: string[];
                      visual_languages: string[]; embedding: number[]; transcript: TranscriptData | null };
type AtlasOut = { thumbnailStorageRef: StorageRef; atlasStorageRef: StorageRef };

// After extractFramesForScene:
type C1 = C0 & { extractFramesForScene: ExtractFramesOut };

// After generateDescriptionsForScene (parallel with 3 sub-branches):
type C2 = C1 & { generateDescriptionsForScene: [ImgEmbedOut, TextEmbedOut, AtlasOut] };
//                                               ^^^[0]       ^^^[1]        ^^^[2]

// Branch 0's full output (subtract initial context):
type Branch0Out = Omit<C2, keyof C0>;
// = { extractFramesForScene: ExtractFramesOut;
//     generateDescriptionsForScene: [ImgEmbedOut, TextEmbedOut, AtlasOut] }

// Branch 1 of processScene:
//   transcodePreviewForScene only
type TranscodePreviewOut = { storageRef: StorageRef; width: number; height: number };
type Branch1Out = { transcodePreviewForScene: TranscodePreviewOut };

// After processScene parallel:
type C3 = C0 & { processScene: [Branch0Out, Branch1Out] };

// Now in createVideoAssetForScene's payload callback, ctx is Proxied<C3>:
//   ctx.processScene[0].generateDescriptionsForScene[2].createAtlasForScene.thumbnailStorageRef
//   → resolves through: C3['processScene'] = [Branch0Out, Branch1Out]
//                        [0] = Branch0Out
//                        ['generateDescriptionsForScene'] = [ImgEmbedOut, TextEmbedOut, AtlasOut]
//                        [2] = AtlasOut
//                        ['thumbnailStorageRef'] = StorageRef ✅
```

##### Edge case: `Proxied<T>` and numeric tuple indexing

For TypeScript to resolve `tuple[0]` to the first element type (not a union), `Proxied<T>` needs to handle tuples specifically:

```typescript
type Proxied<T> =
  Ref<T> &
  // Tuple/array: numeric indexing returns Proxied<element>
  (T extends readonly (infer _)[]
    ? { readonly [K in keyof T]: Proxied<T[K]> }
      // ^^^^^^ for tuples, keyof T includes '0', '1', etc.
      // mapped tuple preserves per-index types
    : unknown) &
  // Object: named property access returns Proxied<property>
  (T extends object
    ? { readonly [K in keyof T]-?: Proxied<T[K]> }
    : unknown);
```

The subtlety: `{ readonly [K in keyof T]: Proxied<T[K]> }` where `T` is a tuple produces a mapped tuple — TypeScript's special rule. This means `Proxied<[A, B]>[0]` is `Proxied<A>`, not `Proxied<A | B>`. This is the same mechanism that makes `[string, number].map(...)` preserve tuple structure in TypeScript's built-in lib types.

### Example: Extraction Step Function

```typescript
type SceneIterationContext = {
  scene: Scene;
  sceneIndex: number;
  isWholeVideo: boolean;
  inputStorageRef: StorageRef;
  transcript: TranscriptData | null;
  parentVideoId: string;
  organizationId: string;
  userId: string;
  filename: string;
  fileUploadId: string | null;
  width: number;
  height: number;
  requestedTags: string[];
  framesOutputFilePrefix: string;
  previewOutputFilePrefix: string;
  atlasOutputFile: string;
};

const sceneProcessor = new SequenceBuilder<SceneIterationContext>()
  .parallel('processScene', [
    // Branch 0: frames → descriptions
    new SequenceBuilder<SceneIterationContext>()
      .task('extractFramesForScene', extractFramesConfig, ctx => ({
        startSeconds: ctx.scene.start_seconds,
        endSeconds: ctx.scene.end_seconds,
        inputStorageRef: ctx.inputStorageRef,
        outputFilePrefix: ctx.framesOutputFilePrefix,
        resolution: 640,
        frameCount: 50,
      }), '$.extractFramesForScene')
      .parallel('generateDescriptionsForScene', [
        // Sub-branch 0: image embedding
        new SequenceBuilder</* inherited */>()
          .task('generateImageEmbeddingForScene', {
            inputSchema: GenerateImageEmbeddingForSceneInputSchema,
            outputSchema: GenerateImageEmbeddingForSceneOutputSchema,
            functionArn: INGESTION_STEP_ARN,
            retry: THROTTLE_RETRY,
          }, ctx => ({
            frameStorageRefs: ctx.extractFramesForScene.frameStorageRefs,
            // ✅ Ref<StorageRef[]> matches schema field type
          }), '$.generateImageEmbeddingForScene'),

        // Sub-branch 1: text embedding
        new SequenceBuilder</* inherited */>()
          .task('generateTextEmbeddingForScene', {
            inputSchema: GenerateTextEmbeddingForSceneInputSchema,
            outputSchema: GenerateTextEmbeddingForSceneOutputSchema,
            functionArn: INGESTION_STEP_ARN,
          }, ctx => ({
            frameStorageRefs: ctx.extractFramesForScene.frameStorageRefs,
            transcript: ctx.transcript,
            scene: ctx.scene,
            sceneIndex: ctx.sceneIndex,
          }), '$.generateTextEmbeddingForScene'),

        // Sub-branch 2: atlas
        new SequenceBuilder</* inherited */>()
          .task('createAtlasForScene', {
            inputSchema: CreateAtlasForSceneInputSchema,
            outputSchema: CreateAtlasForSceneOutputSchema,
            functionArn: INGESTION_STEP_ARN,
          }, ctx => ({
            frameStorageRefs: ctx.extractFramesForScene.frameStorageRefs,
            outputFilename: 'atlas.webp',
          }), '$.createAtlasForScene'),
      ], '$.generateDescriptionsForScene'),

    // Branch 1: transcode preview
    new SequenceBuilder<SceneIterationContext>()
      .task('transcodePreviewForScene', transcodePreviewConfig, ctx => ({
        startSeconds: ctx.scene.start_seconds,
        endSeconds: ctx.scene.end_seconds,
        inputStorageRef: ctx.inputStorageRef,
        outputFilePrefix: ctx.previewOutputFilePrefix,
        resolution: 640,
      }), '$.transcodePreviewForScene'),
  ], '$.processScene')

  // After parallel, context includes:
  //   processScene: [
  //     { extractFramesForScene, generateDescriptionsForScene: [ImgEmbed, TextEmbed, Atlas] },
  //     { transcodePreviewForScene }
  //   ]

  .task('createVideoAssetForScene', {
    inputSchema: CreateVideoAssetForSceneInputSchema,
    outputSchema: CreateVideoAssetForSceneOutputSchema,
    functionArn: INGESTION_STEP_ARN,
  }, ctx => ({
    isWholeVideo: ctx.isWholeVideo,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    filename: ctx.filename,
    parentVideoId: ctx.parentVideoId,
    width: ctx.width,
    height: ctx.height,
    thumbnailStorageRef: ctx.processScene[0].generateDescriptionsForScene[2].createAtlasForScene.thumbnailStorageRef,
    atlasStorageRef: ctx.processScene[0].generateDescriptionsForScene[2].createAtlasForScene.atlasStorageRef,
    previewStorageRef: ctx.processScene[1].transcodePreviewForScene.storageRef,
    transcript: ctx.processScene[0].generateDescriptionsForScene[1].generateTextEmbeddingForScene.transcript,
    descriptionEmbedding: ctx.processScene[0].generateDescriptionsForScene[1].generateTextEmbeddingForScene.embedding,
    imageEmbedding: ctx.processScene[0].generateDescriptionsForScene[0].generateImageEmbeddingForScene.embedding,
    visualLanguages: ctx.processScene[0].generateDescriptionsForScene[1].generateTextEmbeddingForScene.visual_languages,
    text: ctx.processScene[0].generateDescriptionsForScene[1].generateTextEmbeddingForScene.text,
    description: ctx.processScene[0].generateDescriptionsForScene[1].generateTextEmbeddingForScene.description,
    colors: ctx.processScene[0].generateDescriptionsForScene[1].generateTextEmbeddingForScene.colors,
    objects: ctx.processScene[0].generateDescriptionsForScene[1].generateTextEmbeddingForScene.objects,
    scene: ctx.scene,
    sceneIndex: ctx.sceneIndex,
    fileUploadId: ctx.fileUploadId,
    parentTranscript: ctx.transcript,
    requestedTags: ctx.requestedTags,
  }), '$.createVideoAssetForScene');
```

### What this catches at compile time

| Bug | Option A | Option C |
|-----|----------|----------|
| Missing required payload field | Yes | Yes |
| Extra payload field not in schema | Yes | Yes |
| Wrong `step` literal | Yes | Yes |
| Ref to nonexistent state output (`ctx.doesNotExist.foo`) | No | Yes |
| Ref to nonexistent field (`ctx.extractFrames.nonexistent`) | No | Yes |
| Ref type mismatch (passing `Ref<number>` where `StorageRef[]` expected) | No | Yes |
| Wrong parallel branch index (`ctx.processScene[2]` when only 2 branches) | No | Yes |

### Terraform consumption

The generated JSON replaces all `.json.tftpl` state files:

```hcl
module "asset_extraction_step_function" {
  source = "../../modules/step-function"
  name   = "stellar-${var.environment}-asset-extraction"

  definition = jsondecode(templatefile(
    "${path.module}/generated/extraction_definition.json.tftpl",
    {
      asset_ingestion_step_lambda_arn = module.asset_ingestion_step_lambda.lambda_function_arn
      ingestion_transcode_lambda_arn  = module.ingestion_transcode_lambda.lambda_function_arn
      transcode_job_queue_arn         = module.transcode_batch.job_queue_arn
      transcode_job_definition_arn    = module.transcode_batch.job_definition_arn
    }
  ))

  lambda_arns = [
    module.asset_ingestion_step_lambda.lambda_function_arn,
    module.ingestion_transcode_lambda.lambda_function_arn,
  ]
}
```

### CI integration

Add an nx target (e.g. `nx generate-step-functions asset-ingestion-step`) that:
1. Runs `ts-node` to execute the builder script
2. Writes the generated JSON to `terraform/.../generated/`
3. Fails at typecheck if any schema has changed without updating the builder

### Tradeoffs

- **Effort**: ~500-1000 lines of builder/proxy infrastructure
- **Advanced TS**: recursive conditional types, tuple manipulation, Proxies — not every team member will be comfortable debugging the builder internals
- **Error messages**: can be cryptic deep in nested parallel branches
- **Build time**: deeply nested conditional types may slow `tsc`
- **Payoff**: complete compile-time guarantee that step function payloads match handler schemas

---

## Implementation Status

We chose **Option C** and implemented the core library as the `@stellar/step` package.

### What's implemented

#### Core types ([types.ts](packages/step/src/lib/types.ts))

- `REF_PATH` symbol — runtime marker for ref objects
- `Ref<T>` — branded reference carrying phantom type `T` and a path array
- `Proxied<T>` — recursive mapped type that wraps every property (including tuple indices) as `Ref<PropertyType>`
- `AnyZodObject` — Zod 4-compatible constraint (`z.ZodObject<any>`)
- `TypedPayloadMapping<T>` — for each schema field (except `step` and `task`), accepts `z.infer<Field> | Ref<z.infer<Field>>`

#### Proxy runtime ([proxy.ts](packages/step/src/lib/proxy.ts))

- `createProxy<T>()` — JavaScript `Proxy` that records property access as JSONPath segments (handles both named properties and numeric indices)
- `pathOf(ref)` — converts a `Ref`'s path segments to a JSONPath string (e.g. `$.processScene[0].extractFrames.output`). Supports both `$` and `$$` roots.
- `isRef(value)` — type guard checking for `REF_PATH` symbol
- `createMapItemProxy<T>()` — creates typed proxy refs for Map state iteration variables (`$$.Map.Item.Value` and `$$.Map.Item.Index`)

#### SequenceBuilder ([builder.ts](packages/step/src/lib/builder.ts))

- **`task(name, config, payloadFn)`** — appends a Lambda Task state. Auto-generates:
  - `Parameters.Payload` with discriminator literal (`step` or `task`) extracted from input schema, ref values as `"key.$": "$.path"`, static values as-is
  - `ResultSelector` mapping every output schema key to `$.Payload.{key}` (or custom override via `config.resultSelector`)
  - Optional `Retry` config
  - Returns builder with expanded context: `Ctx & Record<Name, z.infer<O>>`

- **`parallel(name, branches)`** — appends a Parallel state. Each branch is a `SequenceBuilder` whose context starts from the current `Ctx`. Uses:
  - `BranchOutputTuple<Base, Branches>` — mapped tuple type that extracts per-branch delta outputs via `Omit<Full, keyof Base>`
  - `declare readonly _ctx: Ctx` phantom property for reliable type extraction via `infer`
  - `[...Branches]` variadic tuple parameter to force tuple inference
  - Returns builder with context: `Ctx & Record<Name, BranchOutputTuple<Ctx, Branches>>`

- **`pass(name, mappingFn, options?)`** — appends a Pass state that reshapes data without invoking a Lambda. Uses:
  - `UnwrapRefs<M>` — maps `Ref<T>` → `T` for each property in the mapping function's return type
  - Ref values become `"key.$": "$.path"` in `Parameters`, static values kept as-is
  - `options.resultPath: null` omits `ResultPath` entirely (output replaces full state input)
  - Returns builder with context: `Ctx & Record<Name, UnwrapRefs<M>>`

- **`map(name, config)`** — appends a Map state that iterates over an array. Uses:
  - `MapConfig<Ctx, ItemType>` — `itemsPath`, `maxConcurrency`, `itemSelector`, `processor`
  - `itemSelector` callback receives `MapItemRef<T>` (typed `$$.Map.Item.Value`/`Index` proxies) and outer `Proxied<Ctx>`
  - Supports intrinsic functions (`statesFormat`, `statesJsonToString`) in selector values
  - `processor` is a pre-built `AslStateMachine` wrapped as an inline `ItemProcessor`
  - Returns builder with context: `Ctx & Record<Name, MapOutput[]>`

- **`customTask(name, config)`** — appends a non-Lambda Task state (e.g. AWS Batch). Uses:
  - `CustomTaskConfig<Ctx>` — `resource`, `parameters` callback, optional `resultPath`, `retry`
  - `parameters` callback supports refs and intrinsic functions at any nesting depth via recursive `serializeParameters()`
  - Returns builder with context: `Ctx & Record<Name, O>`

- **`build(options?)`** — wires up `Next`/`End` pointers and returns an `AslStateMachine` with optional `Comment`

#### Intrinsic functions ([intrinsic.ts](packages/step/src/lib/intrinsic.ts))

- `INTRINSIC_EXPR` symbol — runtime marker for intrinsic expression objects
- `IntrinsicExpr<T>` — branded type carrying a Step Functions intrinsic expression string and phantom result type
- `statesFormat(template, ...args)` — `States.Format(...)` intrinsic function. Arguments can be `Ref` or `IntrinsicExpr`
- `statesJsonToString(ref)` — `States.JsonToString(...)` intrinsic function
- `isIntrinsic(value)` / `getExpression(expr)` — type guard and expression extractor

#### Retry presets

- `DEFAULT_RETRY` — `States.ALL`, 3 attempts, 2s interval, 2x backoff
- `THROTTLE_RETRY` — `ThrottlingException` + `Lambda.TooManyRequestsException` (10 attempts), then falls back to `DEFAULT_RETRY`

#### Exports ([index.ts](packages/step/src/index.ts))

All types and runtime values are re-exported from the barrel: `REF_PATH`, `Ref`, `Proxied`, `TypedPayloadMapping`, `createProxy`, `pathOf`, `isRef`, `createMapItemProxy`, `MapItemRef`, `INTRINSIC_EXPR`, `IntrinsicExpr`, `isIntrinsic`, `getExpression`, `statesFormat`, `statesJsonToString`, `SequenceBuilder`, `DEFAULT_RETRY`, `THROTTLE_RETRY`, `serializeParameters`, `RetryConfig`, `LambdaTaskConfig`, `AslStateMachine`, `BranchOutputTuple`, `UnwrapRefs`, `MapConfig`, `CustomTaskConfig`.

#### Test coverage (75 tests, all passing)

- **proxy.test.ts** (25 tests) — path recording, numeric indices, `isRef`, `pathOf`
- **types.test.ts** (7 tests) — `TypedPayloadMapping` accepts correct types, rejects wrong types
- **builder.test.ts** (43 tests):
  - Runtime: state generation, payload mapping, result selector, retry config, parallel branches, pass reshaping, comment field, function ARN wiring
  - Full JSON output: three-state sequential chain, parallel + downstream task
  - Type-level (`expectTypeOf`): context accumulation, upstream ref types, parallel tuple indexing, pass output unwrapping
  - Intrinsic functions: `statesFormat` expression, `$$` path generation
  - `task` discriminator: auto-fills `task` literal instead of `step`
  - Custom resultSelector: overrides auto-generated mapping
  - Pass with `resultPath: null`: omits `ResultPath` from output
  - Map state: `ItemProcessor`, `ItemSelector` with `$$` refs and intrinsic functions, `MaxConcurrency`
  - Custom task: Batch `submitJob` with nested intrinsic functions
  - **Full extraction step function**: complete expression of `extraction_step_function_definition.json.tftpl` with Map → Parallel → nested Parallel → Pass → Batch

### What was previously missing (now implemented)

All four gaps have been filled:

1. **Map state** — `map(name, config)` method with `ItemsPath`, `ItemSelector`, `MaxConcurrency`, and inline `ItemProcessor`. ✅
2. **Non-Lambda Task resources** — `customTask(name, config)` method with configurable `resource`, nested `parameters` callback, and optional `resultPath`. Used for AWS Batch `submitJob`. ✅
3. **Intrinsic functions** — `statesFormat()` and `statesJsonToString()` produce `IntrinsicExpr` values that serialize to `"key.$": "States.Format(...)"` entries. Recursive `serializeParameters()` handles intrinsics at any nesting depth. ✅
4. **Context object references (`$$`)** — `createMapItemProxy<T>()` creates `$$`-rooted proxies for `$$.Map.Item.Value` and `$$.Map.Item.Index`. `pathOf()` updated to handle `$$` as a root segment. ✅

**Additional changes:**
- `task()` now auto-detects `task` discriminator in addition to `step` (needed for Python-based lambdas like `extract-frames` and `transcode-video`)
- `task()` supports optional `resultSelector` override for renaming fields (e.g. `outputStorageRef` → `storageRef`)
- `pass()` supports `{ resultPath: null }` option to omit `ResultPath` (output replaces entire input)
- `TypedPayloadMapping` excludes both `step` and `task` from required fields

### What's still needed for production use

1. **CI target** — Add an nx target (`nx generate-step-functions asset-ingestion-step`) that runs the builder and writes generated JSON to `terraform/.../generated/`
2. **Terraform migration** — Replace `templatefile()` references in `main.tf` with the generated JSON
3. **Express `ingestion_step_function_definition.json.tftpl`** — the other step function in this directory

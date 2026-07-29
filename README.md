# Step Functions Builder

Generates ASL JSON from TypeScript, with compile-time proof that payload mappings match the Lambdas' Zod schemas and that every JSONPath ref resolves to a real upstream output of the right type.

## Why

Hand-written ASL (`.json.tftpl`) and Lambda handler schemas are disconnected: misaligned payloads, dangling JSONPath references and type mismatches surface only at runtime, mid-execution. If a machine built here typechecks, its payloads are correct.

Caught at compile time: missing or extra payload fields, refs to a nonexistent state (`ctx.doesNotExist.foo`) or field, ref type mismatches, and out-of-range parallel branch indices.

```ts
const machine = new SequenceBuilder<Input>()
  .task(
    'runMediaInfo',
    {
      inputSchema: RunMediainfoStepInput,
      outputSchema: RunMediainfoStepOutput,
      functionArn: LAMBDA_ARN,
    },
    (ctx) => ({ bucket: ctx.bucket, key: ctx.key })
  )
  .task(
    'createVideo',
    {
      inputSchema: CreateVideoInput,
      outputSchema: CreateVideoOutput,
      functionArn: LAMBDA_ARN,
    },
    (ctx) => ({ mediaInfo: ctx.runMediaInfo.mediaInfo })
  )
  .build();
```

Each method appends a state and returns the builder widened with that state's output, so `ctx` at every step is a `Proxied<Ctx>` whose property accesses record JSONPath segments (`$.runMediaInfo.mediaInfo`) while carrying the schema's type.

## Type machinery worth knowing

**Parallel branches are a tuple, not an array.** A Parallel state's ASL output is positional, and a plain `Array<Union>` would lose that. `BranchOutputTuple` is a mapped tuple (`{ [I in keyof Branches]: Omit<Full, keyof Base> }`), which preserves per-index types, so `ctx.process[0]` is branch 0's own output. Two things keep it working: the `[...Branches]` variadic tuple parameter (without it TypeScript infers `SequenceBuilder<any>[]`) and each builder's `declare readonly _ctx: Ctx` phantom field, which is what `infer` extracts.

**`choice` leaves the context type unchanged** — the builder can't know which branch ran. Non-terminal branches converge on the next chained state, `fail` states stay terminal, empty branches skip straight to convergence, and choices nest.

**`pipe(fn)` keeps reusable task groups in a flat chain.** Declare the function generic over `Ctx extends { … }` and the constraint becomes its documented requirement on upstream outputs:

```ts
const addCreateAtlas = <Ctx extends { extractFrames: { frameStorageRefs: StorageRef[] } }>(
  b: SequenceBuilder<Ctx>
) => b.task('createAtlas', createAtlasConfig, (ctx) => ({
  frameStorageRefs: ctx.extractFrames.frameStorageRefs,
  outputFilename: 'atlas.webp',
}));

new SequenceBuilder<Input>().task('extractFrames', …).pipe(addCreateAtlas).task('finalize', …).build();
```

# typed-asl

[![CI](https://img.shields.io/github/actions/workflow/status/solid-labs-inc/typed-asl/ci.yml?branch=main&label=CI)](https://github.com/solid-labs-inc/typed-asl/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/codecov/c/github/solid-labs-inc/typed-asl?label=coverage)](https://codecov.io/gh/solid-labs-inc/typed-asl)
[![npm](https://img.shields.io/npm/v/typed-asl)](https://www.npmjs.com/package/typed-asl)
[![npm provenance](https://img.shields.io/badge/npm%20provenance-signed-brightgreen)](https://www.npmjs.com/package/typed-asl#provenance)
[![runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)

Generates Amazon States Language JSON from TypeScript, with compile-time proof that payload mappings match the Lambdas' Zod schemas and that every JSONPath ref resolves to a real upstream output of the right type.

```bash
npm install typed-asl zod
```

## Why

Hand-written ASL and Lambda handler schemas are disconnected: misaligned payloads, dangling JSONPath references and type mismatches surface only at runtime, mid-execution. If a machine built here typechecks, its payloads are correct.

Caught at compile time: missing or extra payload fields, refs to a nonexistent state (`ctx.doesNotExist.foo`) or field, ref type mismatches, cross-branch parallel access (`ctx.par[1].stateFromBranch0`), out-of-range parallel indices (`ctx.par[2]` on a two-branch parallel), choice conditions whose variable or operand type disagrees with the operator, `map` item selectors that are typos or not arrays, `customTask` refs that point where the result doesn't live, and optional output fields without an explicit `resultSelector`. Known ASL error names (`States.Timeout`, `Lambda.TooManyRequestsException`, …) autocomplete in `retry`/`catch` configs. Every guarantee here has a matching negative test (`src/lib/type-guarantees.test.ts`) that fails the build if the API stops rejecting the bad code.

```ts
import { SequenceBuilder } from 'typed-asl';

const machine = new SequenceBuilder<Input>()
  .task(
    'runMediaInfo',
    {
      inputSchema: RunMediainfoStepInput,
      outputSchema: RunMediainfoStepOutput,
      functionArn: LAMBDA_ARN,
    },
    (ctx) => ({ bucket: ctx.bucket, key: ctx.key }),
  )
  .task(
    'createVideo',
    {
      inputSchema: CreateVideoInput,
      outputSchema: CreateVideoOutput,
      functionArn: LAMBDA_ARN,
    },
    (ctx) => ({ mediaInfo: ctx.runMediaInfo.mediaInfo }),
  )
  .build();
```

Each method appends a state and returns the builder widened with that state's output, so `ctx` at every step is a `Proxied<Ctx>` whose property accesses record JSONPath segments (`$.runMediaInfo.mediaInfo`) while carrying the schema's type.

`build()` returns a plain ASL object. Write it to a file, feed it to Terraform or CDK, or hand it to `CreateStateMachine` — the library has no opinion about deployment.

## Learn it

[`tutorial/`](tutorial) is the documentation: eleven numbered files that build the library's ideas from scratch, each one a runnable test. Start at [`00-the-problem.test.ts`](tutorial/00-the-problem.test.ts) and read in order. Because they are tests, they cannot drift from the implementation.

## Type machinery worth knowing

**Parallel branches are a tuple, not an array.** A Parallel state's ASL output is positional, and a plain `Array<Union>` would lose that. `BranchOutputTuple` is a mapped tuple (`{ [I in keyof Branches]: Omit<Full, keyof Base> }`), which preserves per-index types, so `ctx.process[0]` is branch 0's own output. Two things keep it working: the `[...Branches]` variadic tuple parameter (without it TypeScript infers `SequenceBuilder<any>[]`) and each builder's `declare readonly _ctx: Ctx` phantom field, which is what `infer` extracts.

**The context type hovers as a plain object.** Widening a state's output into the context is written `Omit<Ctx, Name> & Record<Name, Out>` — the `Omit` is what makes a repeated state name replace its earlier entry instead of intersecting with it. Left alone, that composition is what your editor prints, nesting a layer deeper per chained call. Every widening return is wrapped in `Simplify<T> = { [K in keyof T]: T[K] } & {}`, which resolves it to `{ bucket: string; key: string; loadFile: … }` no matter how long the chain. Assignability is unchanged; only the rendering is. One consequence: keys appear in the mapped type's iteration order, not declaration order.

**`choice` leaves the context type unchanged** — the builder can't know which branch ran. Non-terminal branches converge on the next chained state, `fail` states stay terminal, empty branches skip straight to convergence, and choices nest.

**`pipe(fn)` keeps reusable task groups in a flat chain.** Declare the function generic over `Ctx extends { … }` and the constraint becomes its documented requirement on upstream outputs:

```ts
const addCreateAtlas = <
  Ctx extends { extractFrames: { frameStorageRefs: StorageRef[] } },
>(
  b: SequenceBuilder<Ctx>
) =>
  b.task('createAtlas', createAtlasConfig, (ctx) => ({
    frameStorageRefs: ctx.extractFrames.frameStorageRefs,
    outputFilename: 'atlas.webp',
  }));

new SequenceBuilder<Input>()
  .task('extractFrames', …)
  .pipe(addCreateAtlas)
  .task('finalize', …)
  .build();
```

## How this is verified

Each claim above is pinned by something that fails the build when it stops being true.

- **251 tests** across the library and the tutorial, run on Node 20, 22 and 24.
- **Every `build()` in the suite is validated against the ASL spec** with `asl-validator`, through a setup hook rather than per-call-site opt-in — so a fixture AWS would reject cannot pass CI.
- **Negative type tests** ([`src/lib/type-guarantees.test.ts`](src/lib/type-guarantees.test.ts)) pin the compile-time contract as `@ts-expect-error` cases. `tsc` checks those in both directions, so they still fail when inference quietly degrades to `any` — which no passing runtime test would catch.
- **Three compilers**: the pinned `~5.7`, the newest 5.x, and `typescript@latest`. Type-level behavior is this library's API surface, so a compiler upgrade can be a breaking change.
- **Coverage is a ratchet** — the floor sits at 95% statements / 91% branches, and CI fails if it drops. Thresholds only move up, with one documented exception: re-baselining when a coverage-tool major bump shifts attribution (vitest 3 → 4 measured about a point lower on identical code). The badge reads lower than those figures because Codecov counts a partially-covered line as a miss where vitest counts it as hit — the same report is 91% there and 96% lines here.
- **Releases are signed.** Publishing runs from the tagged workflow through npm trusted publishing (OIDC, no long-lived token), so the tarball on npm carries provenance back to this repo and commit.

## Scope

Supported states: `Task` (Lambda, plus a `customTask` escape hatch for any service integration ARN), `Parallel`, `Map`, `Choice`, `Pass`, `Wait`, `Fail`, `Succeed`. `Retry` and `Catch` work on `Task`, `customTask`, `Map`, and `Parallel`; `TimeoutSeconds`/`HeartbeatSeconds` (and their `...Path` variants) on `Task` and `customTask`. Choice supports every JSONPath-mode comparison operator, `*Path` variants included (typed refs on both sides). Intrinsics: the full JSONPath-mode set — `Format`, `JsonToString`, `StringToJson`, `JsonMerge`, `Array`, `ArrayLength`, `ArrayGetItem`, `ArrayContains`, `ArrayRange`, `ArrayUnique`, `ArrayPartition`, `MathAdd`, `MathRandom`, `StringSplit`, `Base64Encode`/`Decode`, `Hash`, `UUID`.

Not yet supported, and worth knowing before you adopt:

- **JSONPath mode only.** The newer JSONata query language and `Assign`/variables are not implemented; the ref machinery assumes JSONPath.
- **No Distributed Map** (`ItemReader`/`ResultWriter`/`ItemBatcher`).
- **Zod only.** Output schemas drive `ResultSelector` generation, so other validators aren't pluggable today.
- **Optional output fields require an explicit `resultSelector`.** The auto-generated selector maps every output schema key from `$.Payload.{key}`, and ASL errors at runtime when a referenced key is absent — so a schema with `.optional()` fields is rejected at compile time (and at build time) unless you pass a `resultSelector` selecting only what the Lambda always returns.
- **`build()` does not validate against the ASL spec.** It guarantees your mappings and refs, not that AWS will accept every machine you can express. (The library's own test fixtures are all checked against the spec with `asl-validator` in CI — your machines at build time are not.)

This came out of a production monorepo, where it builds real state machines — but it has been shaped by a small number of them. Expect rough edges on shapes we haven't hit. Issues and PRs welcome.

## License

MIT

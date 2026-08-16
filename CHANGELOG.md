# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-08-16

Documentation only — no runtime, type-level or packaging changes.

### Changed

- The tutorial chapters are now published at
  [solidlabs.com/docs/typed-asl](https://www.solidlabs.com/docs/typed-asl),
  and the README, the tutorial index and the contributing checklist link
  there. The files in `tutorial/` remain the source.
- `homepage` in `package.json` points at the docs site rather than the
  README anchor, so npm's Homepage link lands on the documentation.
  `repository` and `bugs` are unchanged. This is the reason for the
  release: npm serves that metadata from the published tarball, so it
  cannot change without one. ([#18](https://github.com/solid-labs-inc/typed-asl/pull/18))

## [0.4.0] - 2026-08-16

### Fixed

- Chains no longer hit `TS2589: Type instantiation is excessively deep
and possibly infinite`. Every context-widening call used to return
  `Omit<Ctx, Name> & Record<Name, Out>`, making the context at step N a
  mapped type wrapping step N-1's; resolving that stack cost `2^N`, so
  instantiations doubled with each added call and the 17th failed to
  compile — 16 states being an ordinary size for a state machine. The
  builder now accumulates `[key, output]` pairs in a flat tuple and
  materializes the context from it in one pass, which never wraps a
  previous mapped type. A 16-state chain drops from ~29.3M
  instantiations (and an error) to ~205k, and 40- and 64-state chains
  type-check where they previously could not exist. Cost on this repo's
  own suite is +5.1% instantiations (437,877 → 460,049) with check time
  flat at ~1.0s.
  ([#14](https://github.com/solid-labs-inc/typed-asl/issues/14))

### Changed

- **Breaking (type-level).** `SequenceBuilder` now takes three type
  parameters — `SequenceBuilder<Ctx, Base, E>` — where the latter two
  default from the first and carry the accumulation described above.
  Writing the type with one argument is unaffected:
  `new SequenceBuilder<Input>()`, `SequenceBuilder.create<Input>()`,
  annotating a variable, parameter or return type as
  `SequenceBuilder<SomeCtx>`, and single-type-parameter `pipe` helpers
  (`<C>(b: SequenceBuilder<C>) => …`) all continue to work, because
  `Base` and `E` appear on no property and so take no part in
  assignability. What breaks is matching the type directly:
  `T extends SequenceBuilder<infer C> ? C : never` now yields `never`
  rather than the context — silently, since it is not an error. Use the
  exported `InferContext<T>`, which has always been the supported
  spelling, or match `SequenceBuilder<infer C, any, any>`.
- `AnyBuilder`, `StateEntry` and `ContextOf` are exported for code that
  needs to name a builder or the accumulation directly.
- The accumulated context type now hovers as a plain object. Every
  context-widening return (`task`, `pass`, `map`, `parallel`,
  `customTask`, `choice`'s `Adds` overload) is wrapped in a new
  display-only `Simplify<T> = { [K in keyof T]: T[K] } & {}`, so a
  three-task chain reads
  `{ key: string; bucket: string; loadFile: …; second: …; third: … }`
  instead of three nested `Omit`/`Record` layers. The same wrapping
  resolves the `UnwrapRefs<…>` alias that `pass` and `resultSelector`
  left on the surface. Assignability is unchanged — replacement of an
  overwritten key is preserved (now by `ContextOf`, see the `TS2589`
  entry above), and removing the class's `in out` variance annotation
  still fails to compile. Two consequences worth knowing: keys render in the mapped
  type's iteration order rather than declaration order, and
  `CatchConfig`'s handler parameter is deliberately left unwrapped
  (with `Key` unresolved, `Record<Key, …>` is an index signature that
  flattening would merge into every property). Type-checking cost is
  within noise on the repo's own suite and +8–13% instantiations on
  synthetic 5–15 state chains, with no change to the chain length
  TypeScript can handle. ([#12](https://github.com/solid-labs-inc/typed-asl/issues/12))

## [0.3.0] - 2026-08-16

### Added

- `Wait` state: `wait(name, { seconds | timestamp | secondsPath |
timestampPath })`, with a callback form for typed refs to the context
  (`wait(name, (ctx) => ({ secondsPath: ctx.delay }))`).
- `TimeoutSeconds`/`HeartbeatSeconds` on `task` and `customTask`, plus
  `timeoutSecondsPath`/`heartbeatSecondsPath` taking `Ref<number>`. The
  static and Path forms of an option are mutually exclusive (build-time
  error).
- All 16 `*Path` choice operators. The operand is a typed ref and the
  variable must agree with it — `numericLessThanPath` wants `Ref<number>`
  on both sides.
- `parallel` branches accept factory callbacks
  (`(b) => b.task(...)`) alongside prebuilt builders, like `choice`
  branches — the fresh builder is seeded with the current context, and
  per-index tuple typing is preserved (`BranchInput`, widened
  `BranchOutputTuple`).
- The rest of the JSONPath intrinsic set: `statesArrayGetItem`,
  `statesArrayContains`, `statesArrayRange`, `statesArrayUnique`,
  `statesArrayPartition`, `statesJsonMerge` (shallow, typed as
  `Omit<A, keyof B> & B`), `statesMathRandom`, `statesStringSplit`,
  `statesBase64Encode`/`statesBase64Decode`, `statesHash`.
- `map` accepts `items: (ctx) => ctx.scenes` — a typed ref selector with
  code completion — as the preferred alternative to a raw `itemsPath`
  string; `ItemType` is inferred from the ref.
- `customTask` accepts an optional `outputSchema`, load-bearing exactly
  like `task`'s: it generates a `ResultSelector` projecting each schema
  key from the raw result (`{ "key.$": "$.key" }`) and types the context
  from `z.infer` — no explicit generics. Optional fields are rejected,
  same as `task`.
- Catch handler contexts type the caught error as `AslCatchErrorOutput`
  (`{ Error, Cause }`) instead of `unknown`, so `ctx.error.Cause` is a
  `Ref<string>` usable in conditions and payloads.
- Known ASL and Lambda error names autocomplete in `ErrorEquals`/
  `errorEquals` (`AslErrorName` — arbitrary custom error strings remain
  legal).

### Changed

- **Breaking:** an output schema with `.optional()` fields now requires
  an explicit `resultSelector` — enforced at compile time (the config
  stops typechecking, with the requirement spelled out in the error) and
  at build time. The auto-generated selector references every schema key
  and ASL errors at runtime when one is absent, so this was a
  latent-failure trap.
- **Breaking (type-level):** out-of-range tuple indices on parallel
  results (`ctx.par[2]` on a two-branch parallel) are now compile
  errors, and proxied refs no longer expose array methods (`ctx.arr.map`
  would have recorded the JSONPath `$.arr.map`).
- **Breaking:** `customTask`'s context type now tells the truth. It is
  keyed by the `resultPath` key (previously by the state name, so with
  `resultPath: '$.transcodeJob'` the type said `ctx.transcode` while the
  data lived at `$.transcodeJob` — a dangling ref); with no `resultPath`
  the result replaces the entire input, and the context type follows.
  `resultPath` must be a single `$.{key}` (build-time error otherwise),
  and the `Name`/`O` explicit type parameters are gone — use
  `outputSchema` to type the result.
- **Breaking (type-level):** choice conditions check the variable side —
  `stringEquals` wants a `string`-typed ref (`null`/`undefined`
  admitted), `numericLessThan` a numeric one, and so on
  (`ChoiceVariableOf<T>`). Raw JSONPath strings remain the untyped
  escape hatch; the `is*` type tests still take any variable.

- Every fixture machine in the test suite is now validated against the ASL
  spec with `asl-validator` — a `build()` result that AWS would reject
  fails CI.
- Negative type tests (`@ts-expect-error`) for the compile-time contract:
  missing/extra payload fields, mismatched ref types, dangling context
  refs, cross-branch parallel access, choice operand types, intrinsic
  argument types. These fail even when inference degrades to `any`.
- CI typechecks against the pinned TypeScript (`~5.7`), the newest 5.x,
  and the 7.x line; coverage is enforced with ratchet-only thresholds.

### Fixed

- Context accumulation replaces an overwritten key's type instead of
  intersecting (`Omit<Ctx, Key> & Record<Key, …>` across all state
  methods) — previously a second write to the same `resultPath`/state
  key kept the stale type alive, so refs to overwritten fields compiled.
  `SequenceBuilder` is now explicitly invariant (`in out Ctx`).
- Context-keyed `resultPath`s (`customTask`, `pass` literal-result,
  catch configs) reject nested paths like `'$.a.b'` at compile time
  (`ResultPathKeyCheck` collapses the property to `never`) and at build
  time — previously `customTask` only threw and `pass`/catch silently
  desynced the context type from where the data lands.
- A choice condition carrying two operator keys (which union
  assignability can't reject) or none at all now throws at serialization
  instead of shipping a rule that tests the wrong comparison or invalid
  ASL.
- `map` validates its `items`/`itemsPath` configuration before running
  the selector and processor callbacks, and a non-ref `items` return
  gets a descriptive error instead of a `pathOf` crash; the exported
  `MapConfig` type now admits the `items` form.
- `itemsPath` literal inference (`PathValue`) handles `readonly` arrays
  instead of resolving the item type to `never`.
- A payload field not present in the input schema is now rejected — at
  compile time via `ExactPayload`/`NoExtraPayloadKeys` (both exported),
  and at runtime with a descriptive error. Previously an extra (usually
  typo'd) field was silently sent to the Lambda without ever being
  validated. The runtime check recurses into nested object fields and
  object array elements, honors schemas that accept unknown keys
  (`looseObject`, `.catchall(...)`), and skips `undefined` values, which
  are never serialized.

## [0.2.0] - 2026-08-16

First published release. The 0.1.0 extraction was never published to npm
(its release run failed before the Trusted Publisher was configured).

### Added

- `Catch` support on `task`, `customTask`, and `map`; `Retry` support on
  `map` and `parallel` — handler sequences are typed against the state's
  context.
- Full JSONPath-mode choice operator set (23 operators): string ordering
  and `stringMatches`, numeric/timestamp comparisons, and the `is*` type
  tests. (`*Path` variants are still open — see `docs/plan.md`.)
- Intrinsics: `statesArray`, `statesArrayLength`, `statesStringToJson`,
  `statesUuid`.
- State names are validated (`[A-Za-z_][A-Za-z0-9_]*`) so generated
  `ResultPath`s are always legal JSONPath.

### Changed

- `SequenceBuilder` is now genuinely immutable: every state method returns
  a new builder, so a shared prefix can be forked safely.

### Fixed

- Duplicate state names (including case collisions) now throw at `build()`
  instead of silently overwriting a state.
- A terminal state (`fail`/`succeed`) followed by more states now throws —
  AWS rejects machines with unreachable states.
- `statesFormat` escapes single quotes in the template; apostrophes no
  longer produce unparseable expressions.
- A bare ref or intrinsic as an array element throws with a pointer to
  `statesArray` — ASL has no path substitution inside arrays, so the
  previous output contained literal `"$.x"` strings.
- Refs nested inside objects/arrays of a task payload serialize correctly
  (previously produced `{}`).

## [0.1.0] - 2026-08-06

Initial extraction from the Stellar monorepo. Never published to npm.

### Added

- `SequenceBuilder` with `task`, `customTask`, `parallel`, `map`,
  `choice`, `pass`, `fail`, `succeed`, and `pipe`.
- Proxy-recorded typed refs (`createProxy`, `Ref<T>`, `pathOf`) and
  `TypedPayloadMapping` — task payloads are proven against the Lambda's
  Zod input schema at compile time.
- Auto-generated `ResultSelector` from Zod output schemas, with typed
  custom selectors.
- Intrinsics: `statesFormat`, `statesJsonToString`, `statesMathAdd`.
- Runnable tutorial (`tutorial/00`–`10`) doubling as the documentation.

[Unreleased]: https://github.com/solid-labs-inc/typed-asl/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/solid-labs-inc/typed-asl/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/solid-labs-inc/typed-asl/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/solid-labs-inc/typed-asl/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/solid-labs-inc/typed-asl/releases/tag/v0.2.0
[0.1.0]: https://github.com/solid-labs-inc/typed-asl/commit/2649df6

# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `customTask` accepts an optional `outputSchema` (typing only — no
  ResultSelector, no runtime validation) so its result is typed without
  explicit generics.
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

[Unreleased]: https://github.com/solid-labs-inc/typed-asl/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/solid-labs-inc/typed-asl/releases/tag/v0.2.0
[0.1.0]: https://github.com/solid-labs-inc/typed-asl/commit/2649df6

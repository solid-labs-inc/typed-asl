# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  compile time via `NoExtraPayloadKeys`, and at runtime with a descriptive
  error. Previously an extra (usually typo'd) field was silently sent to
  the Lambda without ever being validated.

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

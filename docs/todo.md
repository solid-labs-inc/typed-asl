# TODO

Remaining work, roughly ordered by value. Pulled from the August 2026 review
pass that produced the 0.2.0 fixes (immutable builders, duplicate-name and
terminal-state guards, array-ref rejection, Catch on Task/Map, full choice
operator set).

## Features

- [ ] **`Wait` state**, and state-level `TimeoutSeconds`/`HeartbeatSeconds`
      on Task states.
- [ ] **`*Path` choice operators** (`StringEqualsPath`, `NumericLessThanPath`,
      …). Natural fit for the ref machinery: the comparison value would be a
      typed `Ref<T>` instead of a literal, e.g.
      `{ variable: ctx.a, numericLessThanPath: ctx.b }`.
- [ ] **Remaining intrinsics**: `States.ArrayGetItem`, `ArrayContains`,
      `ArrayRange`, `ArrayUnique`, `ArrayPartition`, `JsonMerge`, `MathRandom`,
      `StringSplit`, `Base64Encode`/`Base64Decode`, `Hash`.
- [ ] **Factory callbacks for `parallel` branches**, like `choice` already
      has: `parallel('p', [b => b.task(…), b => b.task(…)])` would spare the
      `new SequenceBuilder<Ctx>()` repetition per branch and keep the branch
      context in sync with the chain automatically.
- [ ] **Distributed Map** (`ItemReader`/`ResultWriter`/`ItemBatcher`,
      `Label`, `ToleratedFailurePercentage`).
- [ ] **JSONata mode and `Assign`/variables.** Large: the ref machinery
      assumes JSONPath throughout. Decide whether this is in scope at all
      before starting.
- [ ] **Optional output-schema fields.** The auto-generated `ResultSelector`
      references `$.Payload.{key}` for every schema key, and ASL errors at
      runtime when a key is absent — so `.optional()` output fields require a
      hand-written `resultSelector` today (documented in the README). Worth
      exploring whether `build()` should warn, or whether there is an ASL
      construct that expresses "take if present".

## Confidence

- [ ] **Validate test fixtures against the ASL spec in CI** (asl-validator or
      statelint). Turns "your refs are right" into "AWS will accept this" —
      and would have caught two of the bugs fixed in the review pass
      (`States.Format` quote escaping, literal path strings in arrays).
- [ ] **TypeScript version matrix in CI.** The library's product _is_
      inference, and the pin is `~5.7.2` while TS 7.0 is out. Variadic-tuple
      and phantom-field inference should be exercised against current stable
      before loosening the pin.
- [ ] **Coverage reporting** in CI.
- [ ] **`@ts-expect-error` negative type tests.** CONTRIBUTING advertises
      "deliberate type errors", but the negatives are all
      `expectTypeOf().not.toExtend()`, which is weaker — it can pass when
      inference degrades to `any`.

## Release hygiene

- [x] **Release 0.2.0.** Shipped 2026-08-16 via the tag-triggered workflow;
      trusted publishing (OIDC + provenance) is proven working. Note: the
      npm side needs a Trusted Publisher entry per package
      (org `solid-labs-inc`, repo `typed-asl`, workflow `release.yml`,
      no environment) — its absence fails `npm publish` with a misleading 404.
- ~~Tag `v0.1.0` retroactively~~ — dropped: pushing the tag would trigger
  the release workflow, which fails against npm's duplicate-version check.
  Not worth a workflow guard for one historical tag.
- [ ] **CHANGELOG.md**, npm/CI badges in the README, dependabot (or renovate)
      for dev-dependency updates.

## Punted with reasons

- **Auto-converting ref arrays to `States.Array`** — rejected in favor of
  throwing: literal handling for booleans/objects inside intrinsic args is
  underspecified, and an explicit `statesArray(...)` keeps serialization
  predictable.
- **Warning on optional output fields at `build()` time** — a Lambda whose
  schema marks a field optional may still always include it; a hard error
  would reject working machines. Documented in the README instead (see the
  feature entry above for possible real fixes).

# Plan

Sequenced roadmap for the work recorded in [todo.md](todo.md). Ordering
rationale: confidence infrastructure first — every feature milestone
multiplies the surface those checks protect — then features in increasing
size, with the two genuinely large items (Distributed Map, JSONata) gated
behind explicit design decisions.

Effort labels: **S** ≈ an hour or two, **M** ≈ a day, **L** ≈ multiple days.

## M1 — Confidence (0.2.x, no API changes)

Goal: a regression in either the emitted ASL or the type inference cannot
land silently.

1. **ASL spec validation in CI** (M). Add `asl-validator` as a
   devDependency and a test helper `expectValidAsl(machine)`; apply it to
   every `build()` result asserted in `builder.test.ts` and the tutorial.
   This would have caught two of the 0.2.0 bugs (quote escaping, literal
   path strings in arrays). _Done when:_ CI fails if any fixture machine is
   invalid ASL.
2. **TypeScript version matrix** (S). CI job running `tsc --noEmit` (type
   tests included) against the pinned `~5.7`, latest 5.x, and TS 7.x.
   Lint stays on the pinned version — typescript-eslint support lags major
   compilers. _Done when:_ the matrix is green or exclusions are documented
   in CI comments.
3. **Negative type tests** (S). `@ts-expect-error` cases for the claims in
   README's "Type machinery worth knowing": missing/extra payload fields,
   wrong ref types, dangling state refs, out-of-range parallel indices.
   Unlike `expectTypeOf().not.toExtend()`, these still fail when inference
   degrades to `any`.
4. **Coverage reporting** (S). `vitest --coverage` in CI with a threshold
   at the current level, so it can only ratchet up.
5. **Repo hygiene** (S). `CHANGELOG.md` (backfilled for 0.1.0/0.2.0,
   Keep-a-Changelog format), npm + CI badges in the README, dependabot for
   dev dependencies.

**Status: implemented** (August 2026). Notes from the implementation:

- Validation runs through a vitest setup hook that wraps
  `SequenceBuilder.prototype.build`, so every `build()` anywhere in the
  suite is checked without call-site opt-in. asl-validator mutates its
  input (ajv `useDefaults`); the helper validates a clone.
- Writing the negative tests surfaced two real gaps: extra payload fields
  were accepted (fixed — `NoExtraPayloadKeys` at compile time plus a
  runtime throw in `buildAslPayload`), and out-of-range parallel indices
  like `ctx.par[2]` are still accepted (the `Ref<T> &` intersection in
  `Proxied` defeats tuple bounds checking — moved to M2 below).
- TypeScript 7.0 is stable; the matrix runs `^5` and `latest` (the pinned
  `~5.7.2` is covered by the build job's own typecheck).

### M1 follow-up: publishing the evidence (August 2026)

M1 produced the guarantees; this pass made them visible and hardened the
supply chain the badges implicitly vouch for.

- Badge row settled at six, all machine-checked: CI, coverage, npm
  version, npm provenance, zero runtime dependencies, OpenSSF Scorecard.
  Deliberately excluded — download counts (volatile on a young package,
  and a dip reads as abandonment), bundlephobia and packagephobia (both
  verified failing: upstream rate limit and a bot checkpoint), stars, and
  anything CI already proves (Prettier/ESLint/"types included").
- **Four of the six are in the README; two are staged** — see the open
  item below. A badge that renders `unknown` or `invalid repo path` is
  worse than an absent one in a README whose subject is reliability, so
  neither goes in before its data source is live.
- The README's **How this is verified** section carries the real weight;
  the row is a summary of it. The coverage figure quoted there is the
  _threshold floor_, not the measured value, so it stays true as long as
  the ratchet holds and only ever understates.
- Codecov is reporting only — `codecov.yml` marks both statuses
  informational and the upload runs with `fail_ci_if_error: false`.
  Enforcement stays in `vitest.config.ts`, so a third-party outage cannot
  block a merge or turn a red build green.
- All actions are SHA-pinned with a trailing version comment, workflows
  declare default-deny `permissions`, and checkouts use
  `persist-credentials: false`. Dependabot's github-actions ecosystem
  bumps the pins and rewrites the comments, so this does not rot.
- Not adopted: CodeQL (a pure-transform library with no IO surfaces
  nothing) and Socket.dev (its subject is dependency risk; there are no
  runtime dependencies).

**Open — add the two staged badges** (S). Each is one line at the top of
the README, blocked only on its data source going live:

```markdown
[![coverage](https://img.shields.io/codecov/c/github/solid-labs-inc/typed-asl?label=coverage)](https://codecov.io/gh/solid-labs-inc/typed-asl)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/solid-labs-inc/typed-asl?label=openssf%20scorecard)](https://scorecard.dev/viewer/?uri=github.com/solid-labs-inc/typed-asl)
```

- _Coverage_ needs `CODECOV_TOKEN` in the repo's Actions secrets (from
  codecov.io after enabling the repo) plus one `main` run that uploads.
  Until then the badge reads `coverage: unknown`. The CI upload step is
  already wired and non-fatal, so nothing breaks while the token is
  missing.
- _Scorecard_ needs this branch merged — the workflow only triggers on
  `main` — and then a run with `publish_results: true` landing in the
  public OpenSSF dataset, which can lag by up to a day. Until then the
  badge reads `invalid repo path`. Insert it after confirming
  `https://api.securityscorecards.dev/projects/github.com/solid-labs-inc/typed-asl`
  returns a score.

## M2 — Ergonomics and small states (0.3.0)

Each item is independently shippable; 0.3.0 cuts when they're all in.

1. **`Wait` state** (S). `wait(name, { seconds | timestamp |
secondsPath: Ref<number> | timestampPath: Ref<string> })` — context type
   unchanged.
2. **`TimeoutSeconds` / `HeartbeatSeconds`** (S) on `task` and `customTask`
   config, plus their `...Path` variants taking `Ref<number>`.
3. **`*Path` choice operators** (M). The comparison value is a typed ref
   instead of a literal: `{ variable: ctx.a, numericLessThanPath: ctx.b }`.
   Natural extension of the existing machinery — the operator value
   serializes through `pathOf`, and the type system can require both sides
   to agree (`Ref<number>` with `numericLessThanPath`).
4. **Factory callbacks for `parallel` branches** (M). Accept
   `(b: SequenceBuilder<Ctx>) => SequenceBuilder<…>` per branch like
   `choice` does, alongside the existing prebuilt-builder form. Kills the
   `new SequenceBuilder<Ctx>()` repetition and keeps branch contexts in
   sync with the chain automatically. Type-level care: `BranchOutputTuple`
   must infer from the callback return types — include a test that fails if
   per-index inference degrades to a union.
5. **Remaining intrinsics** (S each): `ArrayGetItem`, `ArrayContains`,
   `ArrayRange`, `ArrayUnique`, `ArrayPartition`, `JsonMerge`,
   `MathRandom`, `StringSplit`, `Base64Encode`/`Base64Decode`, `Hash` —
   typed signatures following the `statesArray`/`statesArrayLength`
   pattern.
6. **Reject out-of-range parallel indices** (S–M). `ctx.par[2]` on a
   two-branch parallel compiles today: `Proxied<T>` intersects the mapped
   tuple with `Ref<T>`, and property access on the intersection falls back
   to the array number-index signature instead of erroring. Needs a
   `Proxied` reshape that preserves tuple bounds; the negative test to
   enable is noted in `type-guarantees.test.ts`.
7. **Design decision — optional output fields.** The auto-generated
   `ResultSelector` errors at runtime on absent keys (documented in the
   README). JSONPath-mode ASL has no "take if present", so the honest
   options are: (a) keep the doc note, (b) make `task()` require an
   explicit `resultSelector` when the output schema has `.optional()`
   fields — a compile error pointing at the real hazard. Leaning (b); it's
   breaking, so it must ride a minor release with a clear error message.

## M3 — Distributed Map (0.4.0)

**Open a design issue before implementing** (per CONTRIBUTING — this is
the largest API-shape decision since the builder itself). Sketch to seed
it:

- Likely shape: a separate `distributedMap()` method rather than a mode
  flag — the config diverges too much (`ItemReader` replaces `itemsPath`,
  so `ItemType` can no longer be inferred from the context and must be
  supplied explicitly; `ResultWriter` changes the result type to S3
  metadata rather than `ProcessorCtx[]`).
- Config surface: `ItemReader`/`ResultWriter`/`ItemBatcher`, `Label`,
  `ToleratedFailurePercentage`/`ToleratedFailureCount`, child
  `ProcessorConfig` (`ExecutionType: STANDARD | EXPRESS`), `MaxConcurrency`.
- Reuse: `retry`/`catch` plumbing and the item-selector proxy carry over
  unchanged.

## M4 — JSONata mode: go/no-go decision (not committed work)

The ref machinery assumes JSONPath end to end; JSONata mode replaces
`Parameters`/`ResultSelector` with `Arguments`/`Output`, adds
`Assign`/variables, and embeds `{% %}` expressions — effectively a second
builder. Before any code: decide whether it's in scope at all.

- Inputs to the decision: user demand (issues), AWS positioning (JSONata
  is the default for new machines in the console), and whether the
  compile-time-proof story even translates (typed JSONata expressions are
  a research project of their own).
- Acceptable outcome: a documented "JSONPath only, by design" stance in
  the README. The worst outcome is a half-implemented second mode.

## 1.0 criteria

Cut 1.0 when all of these hold — not before, and no later than they do:

- M1 and M2 shipped; M3 shipped or explicitly deferred with a README note.
- The M4 decision is made and documented either way.
- No known class of silently-wrong ASL output (everything in that class
  either throws at build time or is caught by the CI validator).
- Public API unchanged across two consecutive minor releases.

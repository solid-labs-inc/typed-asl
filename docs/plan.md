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
6. **Design decision — optional output fields.** The auto-generated
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

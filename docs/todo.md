# TODO

Open work is sequenced in **[plan.md](plan.md)** — milestones M1–M4 with
effort labels, acceptance criteria, and the 1.0 bar. This file keeps what
a roadmap shouldn't: the record of what's done and what was deliberately
not done, so decisions don't get re-litigated.

## Done

- [x] **Release 0.3.0** (2026-08-16) — the full M2 milestone (Wait,
      timeouts, `*Path` choice operators, parallel branch factories, the
      complete JSONPath intrinsic set, the optional-output decision as a
      compile-time gate), a type-tightening pass (honest `customTask`
      context, typed `map` items selector, checked choice variables,
      error-name completion), and two code-review rounds (20 verified
      findings fixed before merge).
- [x] **Release 0.2.0** (2026-08-16) via the tag-triggered workflow;
      trusted publishing (OIDC + provenance) proven working. Note for the
      next package: npm needs a Trusted Publisher entry per package
      (org `solid-labs-inc`, repo `typed-asl`, workflow `release.yml`,
      no environment) — its absence fails `npm publish` with a misleading 404.
- [x] The August 2026 review pass: immutable builders, duplicate-name /
      terminal-state / state-name guards, array-ref rejection +
      `statesArray`, nested payload serialization, Catch on
      Task/customTask/Map, Retry on Map/Parallel, full non-Path choice
      operator set, four new intrinsics.

## Dropped, with reasons

- **Tag `v0.1.0` retroactively** — pushing the tag would trigger the
  release workflow, which fails against npm's duplicate-version check.
  Not worth a workflow guard for one historical tag.
- **Auto-converting ref arrays to `States.Array`** — rejected in favor of
  throwing: literal handling for booleans/objects inside intrinsic args is
  underspecified, and an explicit `statesArray(...)` keeps serialization
  predictable.
- **Warning on optional output fields at `build()` time** — a Lambda whose
  schema marks a field optional may still always include it; a runtime
  warning would cry wolf on working machines. Documented in the README;
  a compile-time requirement for an explicit `resultSelector` is under
  consideration in plan.md M2.

# Contributing

```bash
npm install
npm test
npm run typecheck
```

`typecheck` is not a formality here. A large share of this library's behaviour is type-level, and the tests assert it with `expectTypeOf` and deliberate type errors — a change can leave every runtime assertion green while breaking inference. Both have to pass.

## Adding a state type or option

1. Add or extend the builder method in `src/lib/builder.ts`.
2. Cover the ASL output in `src/lib/builder.test.ts`, and the inference in the same file or `src/lib/types.test.ts`.
3. If it changes how a user writes machines, add it to the relevant `tutorial/` chapter. The tutorial is the documentation, so a feature that isn't there is undocumented.
4. Update the **Scope** section of the README if it moves something out of the "not yet supported" list.

Two things run automatically that are easy to miss:

- Every `build()` result in the whole suite — tutorial chapters included — is validated against the ASL spec (`test/setup.ts` wraps `build` with `asl-validator`). If your test fails with "Machine is not valid ASL", the fixture really is a machine AWS would reject.
- Coverage thresholds (`vitest.config.ts`) only ratchet upward. If your change raises coverage meaningfully, raise the thresholds with it; never lower them to get a PR green.

## Type-level changes

Variadic tuple inference is load-bearing (see the README's _Type machinery worth knowing_). If you touch `BranchOutputTuple`, the `_ctx` phantom field, or the proxy, please include a test that would fail if inference silently degraded to `any` — a passing runtime test does not catch that.

The claims in the README's "Caught at compile time" list are pinned by `src/lib/type-guarantees.test.ts` — `@ts-expect-error` cases that `tsc --noEmit` checks in both directions (a directive over code that now compiles is itself an error). If you strengthen the type system, add the negative case there; CI also typechecks against newer compilers than the pinned one.

## Conventions

- Prettier formats everything: `npm run format`.
- Commit subjects are `type(scope): imperative summary`.
- Please open an issue before a large feature, so we can agree on the API shape first. The public surface is small on purpose.

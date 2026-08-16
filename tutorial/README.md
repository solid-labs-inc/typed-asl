# Tutorial

These files are the documentation. Each is a runnable test, so nothing here can drift from the implementation — `npm test` proves every claim below still holds.

Read them in order. Chapters 0–3 build the type-level primitives; 4 onwards is the public API. They are also published as a browsable site at [solidlabs.com/docs/typed-asl](https://www.solidlabs.com/docs/typed-asl) — same chapters, same order.

| #                               | Chapter           | What it covers                                                                         |
| ------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| [00](00-the-problem.test.ts)    | The Problem       | Why raw ASL JSONPath strings are untyped, and what goes wrong at runtime because of it |
| [01](01-ref.test.ts)            | `Ref<T>`          | The branded phantom type carrying both a path and the type it points at                |
| [02](02-proxy.test.ts)          | `Proxied<T>`      | Using JavaScript Proxies to record paths from ordinary property access                 |
| [03](03-schemas.test.ts)        | Zod schemas       | How a Lambda's input/output schemas become the contract on both sides                  |
| [04](04-builder-basics.test.ts) | `SequenceBuilder` | Context accumulation — how each `.task()` widens the type of `ctx`                     |
| [05](05-serialization.test.ts)  | Serialization     | How refs turn into ASL's `"field.$": "$.path"` form                                    |
| [06](06-intrinsics.test.ts)     | Intrinsics        | `States.Format`, `States.JsonToString`, `States.MathAdd`                               |
| [07](07-parallel.test.ts)       | `parallel`        | Why branch outputs are a tuple rather than a union, and what keeps that working        |
| [08](08-map.test.ts)            | `map`             | Iteration, and the dual context available inside a processor                           |
| [09](09-choice.test.ts)         | `choice`          | Conditional branching, automatic convergence, nesting                                  |
| [10](10-pipe.test.ts)           | `pipe`            | Extracting reusable task groups without nesting the chain                              |

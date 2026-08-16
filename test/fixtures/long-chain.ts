/**
 * Fixture for the chain-length regression guard (#14).
 *
 * Under the previous representation each context-widening call returned
 * `Omit<Ctx, Name> & Record<Name, Out>`, so the context at step N was a
 * mapped type wrapping step N-1's. Resolving that stack cost `2^N` and
 * TypeScript gave up with TS2589 at the 17th call — a 40-state machine
 * was simply not expressible, and 16 states is an ordinary size.
 *
 * This file must type-check with zero errors. It is compiled by
 * `test/long-chain.test.ts` through the compiler API rather than being
 * asserted on with `expectTypeOf`, because the failure mode is a
 * compiler diagnostic, not a wrong type.
 */
import { z } from 'zod';
import { SequenceBuilder } from '../../src/lib/builder.js';

type Input = { key: string; bucket: string };

const In = z.object({ key: z.string() });
const Out = z.object({
  fileUpload: z.object({ id: z.string(), filename: z.string() }),
  size: z.number(),
});
const cfg = { inputSchema: In, outputSchema: Out, functionArn: 'arn' };

/**
 * 40 chained tasks — well past the old ceiling of 16 — ending in a
 * `pass` that reads deep into both the first and the last state, so the
 * whole accumulated context has to resolve, not just its tail.
 */
export const longChain = new SequenceBuilder<Input>()
  .task('step0', cfg, (ctx) => ({ key: ctx.key }))
  .task('step1', cfg, (ctx) => ({ key: ctx.step0.fileUpload.id }))
  .task('step2', cfg, (ctx) => ({ key: ctx.key }))
  .task('step3', cfg, (ctx) => ({ key: ctx.key }))
  .task('step4', cfg, (ctx) => ({ key: ctx.key }))
  .task('step5', cfg, (ctx) => ({ key: ctx.key }))
  .task('step6', cfg, (ctx) => ({ key: ctx.key }))
  .task('step7', cfg, (ctx) => ({ key: ctx.key }))
  .task('step8', cfg, (ctx) => ({ key: ctx.key }))
  .task('step9', cfg, (ctx) => ({ key: ctx.key }))
  .task('step10', cfg, (ctx) => ({ key: ctx.key }))
  .task('step11', cfg, (ctx) => ({ key: ctx.key }))
  .task('step12', cfg, (ctx) => ({ key: ctx.key }))
  .task('step13', cfg, (ctx) => ({ key: ctx.key }))
  .task('step14', cfg, (ctx) => ({ key: ctx.key }))
  .task('step15', cfg, (ctx) => ({ key: ctx.key }))
  .task('step16', cfg, (ctx) => ({ key: ctx.key }))
  .task('step17', cfg, (ctx) => ({ key: ctx.key }))
  .task('step18', cfg, (ctx) => ({ key: ctx.key }))
  .task('step19', cfg, (ctx) => ({ key: ctx.key }))
  .task('step20', cfg, (ctx) => ({ key: ctx.key }))
  .task('step21', cfg, (ctx) => ({ key: ctx.key }))
  .task('step22', cfg, (ctx) => ({ key: ctx.key }))
  .task('step23', cfg, (ctx) => ({ key: ctx.key }))
  .task('step24', cfg, (ctx) => ({ key: ctx.key }))
  .task('step25', cfg, (ctx) => ({ key: ctx.key }))
  .task('step26', cfg, (ctx) => ({ key: ctx.key }))
  .task('step27', cfg, (ctx) => ({ key: ctx.key }))
  .task('step28', cfg, (ctx) => ({ key: ctx.key }))
  .task('step29', cfg, (ctx) => ({ key: ctx.key }))
  .task('step30', cfg, (ctx) => ({ key: ctx.key }))
  .task('step31', cfg, (ctx) => ({ key: ctx.key }))
  .task('step32', cfg, (ctx) => ({ key: ctx.key }))
  .task('step33', cfg, (ctx) => ({ key: ctx.key }))
  .task('step34', cfg, (ctx) => ({ key: ctx.key }))
  .task('step35', cfg, (ctx) => ({ key: ctx.key }))
  .task('step36', cfg, (ctx) => ({ key: ctx.key }))
  .task('step37', cfg, (ctx) => ({ key: ctx.key }))
  .task('step38', cfg, (ctx) => ({ key: ctx.key }))
  .task('step39', cfg, (ctx) => ({ key: ctx.key }))
  .pass('final', (ctx) => ({
    first: ctx.step0.fileUpload.id,
    last: ctx.step39.fileUpload.filename,
    size: ctx.step39.size,
    bucket: ctx.bucket,
  }));

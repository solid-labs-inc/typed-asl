/**
 * Vitest setup: every `build()` call anywhere in the suite — unit tests and
 * tutorial chapters alike — has its result run through asl-validator. A
 * fixture that produces invalid ASL fails its own test, with the validator
 * errors attached, without any call site opting in.
 */
import { SequenceBuilder } from '../src/lib/builder.js';
import { expectValidAsl } from './expect-valid-asl.js';

const originalBuild = SequenceBuilder.prototype.build;

// build() is re-entrant: parallel branches, map processors, choice
// branches, and catch handlers each build() their sub-sequences while the
// outer build() is on the stack. Those fragments are not standalone
// machines (their terminal wiring is finished by the parent), so only the
// outermost build() result is validated — which also avoids paying a
// fresh ajv compile per fragment.
let buildDepth = 0;

SequenceBuilder.prototype.build = function (options) {
  buildDepth++;
  let machine;
  try {
    machine = originalBuild.call(this, options);
  } finally {
    buildDepth--;
  }
  if (buildDepth === 0) expectValidAsl(machine);
  return machine;
};

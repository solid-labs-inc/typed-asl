/**
 * Vitest setup: every `build()` call anywhere in the suite — unit tests and
 * tutorial chapters alike — has its result run through asl-validator. A
 * fixture that produces invalid ASL fails its own test, with the validator
 * errors attached, without any call site opting in.
 */
import { SequenceBuilder } from '../src/lib/builder.js';
import { expectValidAsl } from './expect-valid-asl.js';

const originalBuild = SequenceBuilder.prototype.build;

SequenceBuilder.prototype.build = function (options) {
  const machine = originalBuild.call(this, options);
  expectValidAsl(machine);
  return machine;
};

/**
 * The validator helper itself must actually reject bad machines —
 * otherwise the build() hook in setup.ts (which every other test relies
 * on) would be a rubber stamp.
 */
import { describe, expect, it } from 'vitest';

import { expectValidAsl } from './expect-valid-asl.js';

describe('expectValidAsl', () => {
  it('accepts a minimal valid machine', () => {
    expectValidAsl({
      StartAt: 'Only',
      States: { Only: { Type: 'Pass', End: true } },
    });
  });

  it('rejects a dangling transition target', () => {
    expect(() =>
      expectValidAsl({
        StartAt: 'A',
        States: { A: { Type: 'Pass', Next: 'DoesNotExist' } },
      }),
    ).toThrow('MISSING_TRANSITION_TARGET');
  });

  it('rejects a machine with no terminal state', () => {
    expect(() =>
      expectValidAsl({
        StartAt: 'A',
        States: {
          A: { Type: 'Pass', Next: 'B' },
          B: { Type: 'Pass', Next: 'A' },
        },
      }),
    ).toThrow('MISSING_TERMINAL_STATE');
  });

  it('does not mutate the machine it validates', () => {
    const machine = {
      StartAt: 'Only',
      States: { Only: { Type: 'Pass', End: true } },
    };
    expectValidAsl(machine);
    // asl-validator's ajv runs with useDefaults and would otherwise
    // inject QueryLanguage — the helper validates a clone to prevent it.
    expect(machine.States.Only).toEqual({ Type: 'Pass', End: true });
  });
});

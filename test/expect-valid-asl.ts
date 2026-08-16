import aslValidator from 'asl-validator';

/**
 * Assert that a built state machine is valid ASL according to the official
 * JSON schema and asl-validator's semantic checks (transition targets,
 * terminal states, JSONPath syntax, ARN formats).
 *
 * Throws with the full error list and the offending machine, so a failure
 * in CI pinpoints the fixture immediately.
 */
export function expectValidAsl(machine: unknown): void {
  // asl-validator's ajv instance runs with useDefaults and mutates its
  // input (e.g. injecting `QueryLanguage: "JSONPath"`); validate a clone
  // so the caller's machine stays byte-for-byte what build() returned.
  const { isValid, errors } = aslValidator(structuredClone(machine));
  if (!isValid) {
    const details = errors
      .map((e) => `  - [${e['Error code']}] ${e.Message}`)
      .join('\n');
    throw new Error(
      `Machine is not valid ASL:\n${details}\n\nMachine:\n${JSON.stringify(machine, null, 2)}`,
    );
  }
}

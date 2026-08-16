import { isRef, pathOf } from './proxy.js';
import type { Ref } from './types.js';

// ── Public types ────────────────────────────────────────────────────

/** A variable reference: either a typed Ref or a raw JSONPath string. */
export type ChoiceVariable = Ref<unknown> | string;

/**
 * A condition for a Choice state rule.
 *
 * Simple conditions compare a variable against a value.
 * Compound conditions combine other conditions with `and`, `or`, or `not`.
 */
export type ChoiceCondition =
  | { variable: ChoiceVariable; stringEquals: string }
  | { variable: ChoiceVariable; stringLessThan: string }
  | { variable: ChoiceVariable; stringGreaterThan: string }
  | { variable: ChoiceVariable; stringLessThanEquals: string }
  | { variable: ChoiceVariable; stringGreaterThanEquals: string }
  /** Glob-style comparison: `*` matches any run of characters. */
  | { variable: ChoiceVariable; stringMatches: string }
  | { variable: ChoiceVariable; numericEquals: number }
  | { variable: ChoiceVariable; numericGreaterThan: number }
  | { variable: ChoiceVariable; numericLessThan: number }
  | { variable: ChoiceVariable; numericGreaterThanEquals: number }
  | { variable: ChoiceVariable; numericLessThanEquals: number }
  | { variable: ChoiceVariable; booleanEquals: boolean }
  /** Timestamps are RFC3339 strings, e.g. `'2026-01-01T00:00:00Z'`. */
  | { variable: ChoiceVariable; timestampEquals: string }
  | { variable: ChoiceVariable; timestampLessThan: string }
  | { variable: ChoiceVariable; timestampGreaterThan: string }
  | { variable: ChoiceVariable; timestampLessThanEquals: string }
  | { variable: ChoiceVariable; timestampGreaterThanEquals: string }
  | { variable: ChoiceVariable; isPresent: boolean }
  | { variable: ChoiceVariable; isNull: boolean }
  | { variable: ChoiceVariable; isNumeric: boolean }
  | { variable: ChoiceVariable; isString: boolean }
  | { variable: ChoiceVariable; isBoolean: boolean }
  | { variable: ChoiceVariable; isTimestamp: boolean }
  | { and: ChoiceCondition[] }
  | { or: ChoiceCondition[] }
  | { not: ChoiceCondition };

// ── Serialization ───────────────────────────────────────────────────

/** Map from camelCase condition keys to ASL PascalCase. */
const CONDITION_KEY_MAP: Record<string, string> = {
  stringEquals: 'StringEquals',
  stringLessThan: 'StringLessThan',
  stringGreaterThan: 'StringGreaterThan',
  stringLessThanEquals: 'StringLessThanEquals',
  stringGreaterThanEquals: 'StringGreaterThanEquals',
  stringMatches: 'StringMatches',
  numericEquals: 'NumericEquals',
  numericGreaterThan: 'NumericGreaterThan',
  numericLessThan: 'NumericLessThan',
  numericGreaterThanEquals: 'NumericGreaterThanEquals',
  numericLessThanEquals: 'NumericLessThanEquals',
  booleanEquals: 'BooleanEquals',
  timestampEquals: 'TimestampEquals',
  timestampLessThan: 'TimestampLessThan',
  timestampGreaterThan: 'TimestampGreaterThan',
  timestampLessThanEquals: 'TimestampLessThanEquals',
  timestampGreaterThanEquals: 'TimestampGreaterThanEquals',
  isPresent: 'IsPresent',
  isNull: 'IsNull',
  isNumeric: 'IsNumeric',
  isString: 'IsString',
  isBoolean: 'IsBoolean',
  isTimestamp: 'IsTimestamp',
};

function resolveVariable(v: ChoiceVariable): string {
  if (typeof v === 'string') return v;
  if (isRef(v)) return pathOf(v);
  return String(v);
}

/**
 * Convert a `ChoiceCondition` to ASL JSON format.
 *
 * Simple conditions produce `{ Variable, <Operator>: value }`.
 * Compound conditions produce `{ And/Or/Not: [...] }`.
 */
export function serializeCondition(
  condition: ChoiceCondition,
): Record<string, unknown> {
  // Compound: And
  if ('and' in condition) {
    return { And: condition.and.map(serializeCondition) };
  }
  // Compound: Or
  if ('or' in condition) {
    return { Or: condition.or.map(serializeCondition) };
  }
  // Compound: Not
  if ('not' in condition) {
    return { Not: serializeCondition(condition.not) };
  }

  // Simple condition — has `variable` plus one operator key
  const result: Record<string, unknown> = {
    Variable: resolveVariable(condition.variable),
  };

  for (const [camel, pascal] of Object.entries(CONDITION_KEY_MAP)) {
    if (camel in condition) {
      result[pascal] = (condition as Record<string, unknown>)[camel];
      break;
    }
  }

  return result;
}

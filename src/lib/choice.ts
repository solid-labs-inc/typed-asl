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
  | { variable: ChoiceVariable; numericEquals: number }
  | { variable: ChoiceVariable; numericGreaterThan: number }
  | { variable: ChoiceVariable; numericLessThan: number }
  | { variable: ChoiceVariable; booleanEquals: boolean }
  | { variable: ChoiceVariable; isPresent: boolean }
  | { variable: ChoiceVariable; isNull: boolean }
  | { and: ChoiceCondition[] }
  | { or: ChoiceCondition[] }
  | { not: ChoiceCondition };

// ── Serialization ───────────────────────────────────────────────────

/** Map from camelCase condition keys to ASL PascalCase. */
const CONDITION_KEY_MAP: Record<string, string> = {
  stringEquals: 'StringEquals',
  numericEquals: 'NumericEquals',
  numericGreaterThan: 'NumericGreaterThan',
  numericLessThan: 'NumericLessThan',
  booleanEquals: 'BooleanEquals',
  isPresent: 'IsPresent',
  isNull: 'IsNull',
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

import { isRef, pathOf } from './proxy.js';
import type { Ref } from './types.js';

// ── Public types ────────────────────────────────────────────────────

/** A variable reference: either a typed Ref or a raw JSONPath string. */
export type ChoiceVariable = Ref<unknown> | string;

/**
 * The variable side of a typed comparison: a ref whose type agrees with
 * the operator (`null`/`undefined` admitted, since nullable fields are
 * exactly what conditions inspect), or a raw JSONPath string as the
 * escape hatch.
 */
export type ChoiceVariableOf<T> = Ref<T | null | undefined> | string;

/**
 * A condition for a Choice state rule.
 *
 * Simple conditions compare a variable against a value.
 * Compound conditions combine other conditions with `and`, `or`, or `not`.
 */
export type ChoiceCondition =
  | { variable: ChoiceVariableOf<string>; stringEquals: string }
  | { variable: ChoiceVariableOf<string>; stringLessThan: string }
  | { variable: ChoiceVariableOf<string>; stringGreaterThan: string }
  | { variable: ChoiceVariableOf<string>; stringLessThanEquals: string }
  | { variable: ChoiceVariableOf<string>; stringGreaterThanEquals: string }
  /** Glob-style comparison: `*` matches any run of characters. */
  | { variable: ChoiceVariableOf<string>; stringMatches: string }
  | { variable: ChoiceVariableOf<number>; numericEquals: number }
  | { variable: ChoiceVariableOf<number>; numericGreaterThan: number }
  | { variable: ChoiceVariableOf<number>; numericLessThan: number }
  | { variable: ChoiceVariableOf<number>; numericGreaterThanEquals: number }
  | { variable: ChoiceVariableOf<number>; numericLessThanEquals: number }
  | { variable: ChoiceVariableOf<boolean>; booleanEquals: boolean }
  /** Timestamps are RFC3339 strings, e.g. `'2026-01-01T00:00:00Z'`. */
  | { variable: ChoiceVariableOf<string>; timestampEquals: string }
  | { variable: ChoiceVariableOf<string>; timestampLessThan: string }
  | { variable: ChoiceVariableOf<string>; timestampGreaterThan: string }
  | { variable: ChoiceVariableOf<string>; timestampLessThanEquals: string }
  | { variable: ChoiceVariableOf<string>; timestampGreaterThanEquals: string }
  | { variable: ChoiceVariable; isPresent: boolean }
  | { variable: ChoiceVariable; isNull: boolean }
  | { variable: ChoiceVariable; isNumeric: boolean }
  | { variable: ChoiceVariable; isString: boolean }
  | { variable: ChoiceVariable; isBoolean: boolean }
  | { variable: ChoiceVariable; isTimestamp: boolean }
  // `*Path` variants compare two values from the state data. The operand
  // is a typed ref, and the variable is required to agree with it —
  // `numericLessThanPath` wants Ref<number> on both sides. (StringMatches
  // has no Path variant in the ASL spec.)
  | { variable: ChoiceVariableOf<string>; stringEqualsPath: Ref<string> }
  | { variable: ChoiceVariableOf<string>; stringLessThanPath: Ref<string> }
  | { variable: ChoiceVariableOf<string>; stringGreaterThanPath: Ref<string> }
  | {
      variable: ChoiceVariableOf<string>;
      stringLessThanEqualsPath: Ref<string>;
    }
  | {
      variable: ChoiceVariableOf<string>;
      stringGreaterThanEqualsPath: Ref<string>;
    }
  | { variable: ChoiceVariableOf<number>; numericEqualsPath: Ref<number> }
  | { variable: ChoiceVariableOf<number>; numericLessThanPath: Ref<number> }
  | { variable: ChoiceVariableOf<number>; numericGreaterThanPath: Ref<number> }
  | {
      variable: ChoiceVariableOf<number>;
      numericLessThanEqualsPath: Ref<number>;
    }
  | {
      variable: ChoiceVariableOf<number>;
      numericGreaterThanEqualsPath: Ref<number>;
    }
  | { variable: ChoiceVariableOf<boolean>; booleanEqualsPath: Ref<boolean> }
  | { variable: ChoiceVariableOf<string>; timestampEqualsPath: Ref<string> }
  | { variable: ChoiceVariableOf<string>; timestampLessThanPath: Ref<string> }
  | {
      variable: ChoiceVariableOf<string>;
      timestampGreaterThanPath: Ref<string>;
    }
  | {
      variable: ChoiceVariableOf<string>;
      timestampLessThanEqualsPath: Ref<string>;
    }
  | {
      variable: ChoiceVariableOf<string>;
      timestampGreaterThanEqualsPath: Ref<string>;
    }
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
  stringEqualsPath: 'StringEqualsPath',
  stringLessThanPath: 'StringLessThanPath',
  stringGreaterThanPath: 'StringGreaterThanPath',
  stringLessThanEqualsPath: 'StringLessThanEqualsPath',
  stringGreaterThanEqualsPath: 'StringGreaterThanEqualsPath',
  numericEqualsPath: 'NumericEqualsPath',
  numericLessThanPath: 'NumericLessThanPath',
  numericGreaterThanPath: 'NumericGreaterThanPath',
  numericLessThanEqualsPath: 'NumericLessThanEqualsPath',
  numericGreaterThanEqualsPath: 'NumericGreaterThanEqualsPath',
  booleanEqualsPath: 'BooleanEqualsPath',
  timestampEqualsPath: 'TimestampEqualsPath',
  timestampLessThanPath: 'TimestampLessThanPath',
  timestampGreaterThanPath: 'TimestampGreaterThanPath',
  timestampLessThanEqualsPath: 'TimestampLessThanEqualsPath',
  timestampGreaterThanEqualsPath: 'TimestampGreaterThanEqualsPath',
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

  // Simple condition — has `variable` plus exactly one operator key.
  // Union assignability can't reject an object carrying two operator
  // keys (each key exists in some union arm), and a missing operator
  // would serialize to a bare { Variable } that AWS rejects at deploy
  // time — both are caught here instead of shipping wrong ASL.
  const operatorKeys = Object.keys(CONDITION_KEY_MAP).filter(
    (camel) => camel in condition,
  );
  if (operatorKeys.length !== 1) {
    const detail =
      operatorKeys.length === 0
        ? 'has no comparison operator'
        : `has ${operatorKeys.length} comparison operators (${operatorKeys.join(', ')}) — use and: [...] to combine conditions`;
    throw new Error(
      `Choice condition on variable "${resolveVariable(condition.variable)}" ${detail}`,
    );
  }

  const camel = operatorKeys[0]!;
  const operand = (condition as Record<string, unknown>)[camel];
  return {
    Variable: resolveVariable(condition.variable),
    // `*Path` operands are refs (or raw paths) — serialize the path,
    // not the ref object.
    [CONDITION_KEY_MAP[camel]!]: camel.endsWith('Path')
      ? resolveVariable(operand as ChoiceVariable)
      : operand,
  };
}

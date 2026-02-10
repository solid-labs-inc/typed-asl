import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Proxied, Ref, TypedPayloadMapping } from './types.js';

// ── Test schemas (used via typeof in type-level assertions) ─────────
/* eslint-disable @typescript-eslint/no-unused-vars */

const StorageRefSchema = z.object({ bucket: z.string(), key: z.string() });

const SimpleSchema = z.object({
  step: z.literal('do-thing'),
  name: z.string(),
  count: z.number(),
});

const ComplexSchema = z.object({
  step: z.literal('create-asset'),
  organizationId: z.string(),
  width: z.number(),
  isWholeVideo: z.boolean(),
  storageRef: StorageRefSchema,
  tags: z.array(z.string()),
  transcript: z.string().nullable(),
  embedding: z.array(z.number()),
});

// ── TypedPayloadMapping ─────────────────────────────────────────────

describe('TypedPayloadMapping', () => {
  it('should include all fields from the schema', () => {
    type Mapping = TypedPayloadMapping<typeof SimpleSchema>;

    // All fields including 'step' should be keys
    expectTypeOf<Mapping>().toHaveProperty('step');
    expectTypeOf<Mapping>().toHaveProperty('name');
    expectTypeOf<Mapping>().toHaveProperty('count');
  });

  it('should accept static values matching the schema type', () => {
    type Mapping = TypedPayloadMapping<typeof SimpleSchema>;

    expectTypeOf<string>().toExtend<Mapping['name']>();
    expectTypeOf<number>().toExtend<Mapping['count']>();
  });

  it('should accept Ref<T> where T matches the field type', () => {
    type Mapping = TypedPayloadMapping<typeof SimpleSchema>;

    expectTypeOf<Ref<string>>().toExtend<Mapping['name']>();
    expectTypeOf<Ref<number>>().toExtend<Mapping['count']>();
  });

  it('should reject Ref<T> where T does not match', () => {
    type Mapping = TypedPayloadMapping<typeof SimpleSchema>;

    // Ref<number> should NOT satisfy a string field
    expectTypeOf<Ref<number>>().not.toExtend<Mapping['name']>();
    // Ref<string> should NOT satisfy a number field
    expectTypeOf<Ref<string>>().not.toExtend<Mapping['count']>();
  });

  it('should handle complex field types', () => {
    type Mapping = TypedPayloadMapping<typeof ComplexSchema>;

    // Object field
    expectTypeOf<{ bucket: string; key: string }>().toExtend<
      Mapping['storageRef']
    >();
    expectTypeOf<Ref<{ bucket: string; key: string }>>().toExtend<
      Mapping['storageRef']
    >();

    // Array field
    expectTypeOf<string[]>().toExtend<Mapping['tags']>();
    expectTypeOf<Ref<string[]>>().toExtend<Mapping['tags']>();

    // Nullable field
    expectTypeOf<string | null>().toExtend<Mapping['transcript']>();
    expectTypeOf<Ref<string | null>>().toExtend<Mapping['transcript']>();

    // Boolean field
    expectTypeOf<boolean>().toExtend<Mapping['isWholeVideo']>();
    expectTypeOf<Ref<boolean>>().toExtend<Mapping['isWholeVideo']>();
  });

  it('should reject extra fields not in the schema', () => {
    type Mapping = TypedPayloadMapping<typeof SimpleSchema>;
    type WithExtra = Mapping & { extra: string };

    // An object with an extra field should NOT be assignable to Mapping
    expectTypeOf<WithExtra>().not.toEqualTypeOf<Mapping>();
  });

  it('should work with Proxied refs from createProxy', () => {
    type Ctx = {
      loadFileUpload: { fileUpload: { organizationId: string } };
      width: number;
      tags: string[];
    };

    type Mapping = TypedPayloadMapping<typeof ComplexSchema>;

    // Proxied values should satisfy Ref<T> for matching types
    expectTypeOf<
      Proxied<Ctx>['loadFileUpload']['fileUpload']['organizationId']
    >().toExtend<Mapping['organizationId']>();
    expectTypeOf<Proxied<Ctx>['width']>().toExtend<Mapping['width']>();
    expectTypeOf<Proxied<Ctx>['tags']>().toExtend<Mapping['tags']>();

    // Proxied<number> should NOT satisfy a string field
    expectTypeOf<Proxied<Ctx>['width']>().not.toExtend<
      Mapping['organizationId']
    >();
  });
});

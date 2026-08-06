/**
 * Chapter 5: Serialization — Refs Become ASL
 *
 * When you write `ctx.runMediaInfo.width` in a payload function, you get a
 * `Ref<number>`. But the final ASL JSON needs `"width.$": "$.runMediaInfo.width"`.
 *
 * `serializeParameters()` is the function that bridges these worlds. It walks
 * an object and applies these rules:
 *
 *   - `Ref` values → `"key.$": "$.path"` (JSONPath reference)
 *   - `IntrinsicExpr` values → `"key.$": "States.Format(...)"` (intrinsic)
 *   - Nested objects → recursed
 *   - Arrays → each element serialized individually
 *   - Primitives (string, number, boolean) → kept as-is
 *
 * The `.$` suffix is ASL's way of saying "this value is a JSONPath, not a
 * literal". This is the key syntax that serializeParameters generates.
 */
import { describe, it, expect } from 'vitest';

import {
  createProxy,
  serializeParameters,
  statesFormat,
  statesJsonToString,
} from '../src/index.js';

describe('Chapter 5: Serialization — Refs Become ASL', () => {
  // ── Refs become "key.$" entries ──────────────────────────────────────

  it('Ref values serialize to "key.$": "$.path"', () => {
    type Ctx = { bucket: string; metadata: { width: number } };
    const ctx = createProxy<Ctx>();

    const result = serializeParameters({
      bucket: ctx.bucket,
      width: ctx.metadata.width,
    });

    // Each Ref becomes a "key.$" entry with the JSONPath string as value
    expect(result).toEqual({
      'bucket.$': '$.bucket',
      'width.$': '$.metadata.width',
    });
  });

  // ── Static values pass through ───────────────────────────────────────

  it('static values are kept as-is (no .$ suffix)', () => {
    const result = serializeParameters({
      format: 'mp4',
      quality: 90,
      enabled: true,
    });

    // No ".$" suffix — these are literal values in the ASL
    expect(result).toEqual({
      format: 'mp4',
      quality: 90,
      enabled: true,
    });
  });

  // ── Mixed refs and statics ───────────────────────────────────────────

  it('refs and static values can be mixed in the same object', () => {
    type Ctx = { inputBucket: string; inputKey: string };
    const ctx = createProxy<Ctx>();

    const result = serializeParameters({
      bucket: ctx.inputBucket,
      key: ctx.inputKey,
      outputFormat: 'webp', // static
      maxWidth: 1920, // static
    });

    expect(result).toEqual({
      'bucket.$': '$.inputBucket',
      'key.$': '$.inputKey',
      outputFormat: 'webp',
      maxWidth: 1920,
    });
  });

  // ── Nested objects are recursed ──────────────────────────────────────

  it('nested objects are recursively serialized', () => {
    type Ctx = { video: { width: number; height: number } };
    const ctx = createProxy<Ctx>();

    const result = serializeParameters({
      dimensions: {
        width: ctx.video.width,
        height: ctx.video.height,
      },
      settings: {
        codec: 'h264',
        profile: 'high',
      },
    });

    expect(result).toEqual({
      dimensions: {
        'width.$': '$.video.width',
        'height.$': '$.video.height',
      },
      settings: {
        codec: 'h264',
        profile: 'high',
      },
    });
  });

  // ── Arrays ───────────────────────────────────────────────────────────

  it('arrays have each element serialized individually', () => {
    type Ctx = { name: string; id: string };
    const ctx = createProxy<Ctx>();

    const result = serializeParameters({
      tags: ['video', 'processed'],
      env: [
        { Name: 'ID', Value: ctx.id },
        { Name: 'TYPE', Value: 'asset' },
      ],
    });

    expect(result).toEqual({
      tags: ['video', 'processed'],
      env: [
        { Name: 'ID', 'Value.$': '$.id' },
        { Name: 'TYPE', Value: 'asset' },
      ],
    });
  });

  // ── Intrinsics serialize to "key.$" too ──────────────────────────────

  it('IntrinsicExpr values also become "key.$" entries', () => {
    type Ctx = { sceneId: string; data: unknown };
    const ctx = createProxy<Ctx>();

    const result = serializeParameters({
      label: statesFormat('scene_{}', ctx.sceneId),
      dataString: statesJsonToString(ctx.data),
    });

    // Intrinsics use the same ".$" suffix but with function call expressions
    expect(result).toEqual({
      'label.$': "States.Format('scene_{}', $.sceneId)",
      'dataString.$': 'States.JsonToString($.data)',
    });
  });

  // ── Full example: realistic Lambda payload ───────────────────────────

  it('a realistic Lambda payload with mixed value types', () => {
    type Ctx = {
      loadFile: { fileUpload: { id: string; organizationId: string } };
      runMediaInfo: { mediaInfo: { width: number; height: number } };
    };
    const ctx = createProxy<Ctx>();

    const result = serializeParameters({
      fileId: ctx.loadFile.fileUpload.id,
      orgId: ctx.loadFile.fileUpload.organizationId,
      width: ctx.runMediaInfo.mediaInfo.width,
      height: ctx.runMediaInfo.mediaInfo.height,
      outputFormat: 'mp4',
      label: statesFormat(
        '{}_{}',
        ctx.loadFile.fileUpload.id,
        ctx.runMediaInfo.mediaInfo.width,
      ),
    });

    expect(result).toEqual({
      'fileId.$': '$.loadFile.fileUpload.id',
      'orgId.$': '$.loadFile.fileUpload.organizationId',
      'width.$': '$.runMediaInfo.mediaInfo.width',
      'height.$': '$.runMediaInfo.mediaInfo.height',
      outputFormat: 'mp4',
      'label.$':
        "States.Format('{}_{}', $.loadFile.fileUpload.id, $.runMediaInfo.mediaInfo.width)",
    });
  });
});

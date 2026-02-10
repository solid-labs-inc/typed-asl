/**
 * Chapter 2: Proxied<T> and createProxy — Tracing Property Access
 *
 * A `Ref<T>` carries a typed JSONPath, but how do we *create* them without
 * manually specifying path strings? The answer is JavaScript Proxies.
 *
 * `createProxy<T>()` returns a `Proxied<T>` — a Proxy object where every
 * property access records the property name as a path segment and returns
 * a new proxy for the property's type. The result is that ordinary
 * TypeScript property access (`ctx.foo.bar[0].baz`) is silently traced
 * into a JSONPath string (`"$.foo.bar[0].baz"`).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Proxied, Ref } from '../src/index.js';
import { createProxy, pathOf } from '../src/index.js';

describe('Chapter 2: Proxied<T> — Property Access Tracing', () => {
  // ── Basic property access ────────────────────────────────────────────

  it('property access on a proxy traces into JSONPath segments', () => {
    type State = {
      bucket: string;
      mediaInfo: { width: number; height: number };
    };

    const ctx = createProxy<State>();

    // Each property access returns a new proxy with the path extended.
    expect(pathOf(ctx)).toBe('$');
    expect(pathOf(ctx.bucket)).toBe('$.bucket');
    expect(pathOf(ctx.mediaInfo)).toBe('$.mediaInfo');
    expect(pathOf(ctx.mediaInfo.width)).toBe('$.mediaInfo.width');
    expect(pathOf(ctx.mediaInfo.height)).toBe('$.mediaInfo.height');
  });

  // ── Deep nesting ─────────────────────────────────────────────────────

  it('deeply nested access builds up the full path', () => {
    type State = {
      video: {
        metadata: {
          tracks: {
            audio: { codec: string };
          };
        };
      };
    };

    const ctx = createProxy<State>();
    expect(pathOf(ctx.video.metadata.tracks.audio.codec)).toBe(
      '$.video.metadata.tracks.audio.codec'
    );
  });

  // ── Array indexing ───────────────────────────────────────────────────

  it('numeric indices use bracket notation in the JSONPath', () => {
    type State = {
      frames: { url: string; width: number }[];
    };

    const ctx = createProxy<State>();

    // Numeric property access becomes bracket notation
    expect(pathOf(ctx.frames[0])).toBe('$.frames[0]');
    expect(pathOf(ctx.frames[0].url)).toBe('$.frames[0].url');
    expect(pathOf(ctx.frames[2].width)).toBe('$.frames[2].width');
  });

  // ── Tuple typing ─────────────────────────────────────────────────────

  it('tuple types preserve per-index types', () => {
    // When the type is a tuple (not just an array), each index has its own type.
    // This is important for parallel branch outputs (chapter 7).
    type ParallelOutput = [
      { extractedFrames: string[] },
      { transcodedUrl: string }
    ];

    const ctx = createProxy<{ process: ParallelOutput }>();

    // Index 0 has the extractedFrames property
    expectTypeOf(ctx.process[0].extractedFrames).toExtend<Ref<string[]>>();

    // Index 1 has the transcodedUrl property
    expectTypeOf(ctx.process[1].transcodedUrl).toExtend<Ref<string>>();

    // The paths are correct
    expect(pathOf(ctx.process[0].extractedFrames)).toBe(
      '$.process[0].extractedFrames'
    );
    expect(pathOf(ctx.process[1].transcodedUrl)).toBe(
      '$.process[1].transcodedUrl'
    );
  });

  // ── Type safety ──────────────────────────────────────────────────────

  it('Proxied<T> preserves the full type at each level', () => {
    type State = {
      count: number;
      nested: { flag: boolean; items: string[] };
    };

    const ctx = createProxy<State>();

    // Each level is properly typed
    expectTypeOf(ctx).toExtend<Proxied<State>>();
    expectTypeOf(ctx.count).toExtend<Ref<number>>();
    expectTypeOf(ctx.nested).toExtend<
      Ref<{ flag: boolean; items: string[] }>
    >();
    expectTypeOf(ctx.nested.flag).toExtend<Ref<boolean>>();
    expectTypeOf(ctx.nested.items).toExtend<Ref<string[]>>();
  });

  // ── Proxies are immutable path builders ──────────────────────────────

  it('each access creates a new proxy — proxies are not mutated', () => {
    type State = { a: { b: string } };
    const ctx = createProxy<State>();

    // Accessing a property doesn't mutate the parent proxy
    const aRef = ctx.a;
    const bRef = ctx.a.b;

    expect(pathOf(ctx)).toBe('$');
    expect(pathOf(aRef)).toBe('$.a');
    expect(pathOf(bRef)).toBe('$.a.b');
  });
});

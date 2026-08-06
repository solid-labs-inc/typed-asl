import { describe, expectTypeOf, it } from 'vitest';
import { SequenceBuilder } from './builder.js';
import type { PathValue } from './path.js';
import type { Proxied } from './types.js';

// We'll trust that PathValue is not implemented yet, so expect TS errors if we tried to use it.
// For now, let's just make a test that fails compilation OR runtime if we were to rely on inference today.
// Actually, I'll create the test file assuming PathValue exists to define what we WANT.

describe('PathValue', () => {
  interface TestState {
    simple: number;
    nested: {
      field: string;
      array: { id: number }[];
      tuple: [string, number];
    };
    list: number[];
  }

  it('infers simple paths', () => {
    expectTypeOf<PathValue<TestState, '$.simple'>>().toEqualTypeOf<number>();
  });

  it('infers nested paths', () => {
    expectTypeOf<
      PathValue<TestState, '$.nested.field'>
    >().toEqualTypeOf<string>();
  });

  it('infers array indexing', () => {
    expectTypeOf<PathValue<TestState, '$.nested.array[0]'>>().toEqualTypeOf<{
      id: number;
    }>();
    expectTypeOf<PathValue<TestState, '$.list[0]'>>().toEqualTypeOf<number>();
  });

  it('infers array indexing with multiple levels', () => {
    expectTypeOf<
      PathValue<TestState, '$.nested.array[0].id'>
    >().toEqualTypeOf<number>();
  });
});

describe('SequenceBuilder.map inference', () => {
  interface MyContext {
    items: { id: string }[];
    complex: { scenes: { url: string }[] };
  }

  it('should infer item type from itemsPath', () => {
    // This is the goal syntax
    new SequenceBuilder<MyContext>().map('testMap', {
      itemsPath: '$.items',
      itemSelector: (item, _ctx) => {
        // item.value should be { id: string }
        expectTypeOf(item.value.id).toEqualTypeOf<Proxied<string>>();
        return {
          myId: item.value.id,
        };
      },
      processor: (b) => b.pass('placeholder', (_ctx) => ({})),
    });
  });
});

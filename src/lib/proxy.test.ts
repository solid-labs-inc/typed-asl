import { describe, it, expect } from 'vitest';

import { createProxy, isRef, pathOf } from './proxy.js';
import { REF_PATH } from './types.js';

// ── Test types ──────────────────────────────────────────────────────

type StorageRef = { bucket: string; key: string };

type SimpleContext = {
  jobId: string;
  bucket: string;
  fileUpload: {
    id: string;
    organizationId: string;
    filename: string;
    storage: StorageRef;
  };
};

type ContextWithArray = {
  scenes: Array<{
    start_seconds: number;
    end_seconds: number;
    name: string;
  }>;
  frameStorageRefs: StorageRef[];
};

type ContextWithTuple = {
  processScene: [
    {
      extractFrames: { frameStorageRefs: StorageRef[]; width: number };
      generateDescriptions: [
        { embedding: number[] },
        { description: string; embedding: number[] },
        { thumbnailStorageRef: StorageRef; atlasStorageRef: StorageRef },
      ];
    },
    {
      transcodePreview: { storageRef: StorageRef };
    },
  ];
};

type DeeplyNested = {
  a: {
    b: {
      c: {
        d: {
          value: string;
        };
      };
    };
  };
};

// ── createProxy ─────────────────────────────────────────────────────

describe('createProxy', () => {
  it('should create a proxy with root path "$"', () => {
    const proxy = createProxy<SimpleContext>();
    expect(proxy[REF_PATH]).toEqual(['$']);
  });

  it('should record single property access', () => {
    const proxy = createProxy<SimpleContext>();
    const ref = proxy.jobId;
    expect(ref[REF_PATH]).toEqual(['$', 'jobId']);
  });

  it('should record nested property access', () => {
    const proxy = createProxy<SimpleContext>();
    const ref = proxy.fileUpload.organizationId;
    expect(ref[REF_PATH]).toEqual(['$', 'fileUpload', 'organizationId']);
  });

  it('should record deeply nested property access', () => {
    const proxy = createProxy<DeeplyNested>();
    const ref = proxy.a.b.c.d.value;
    expect(ref[REF_PATH]).toEqual(['$', 'a', 'b', 'c', 'd', 'value']);
  });

  it('should record numeric index access as bracket segments', () => {
    const proxy = createProxy<ContextWithArray>();
    const ref = proxy.scenes[0];
    expect(ref[REF_PATH]).toEqual(['$', 'scenes', '[0]']);
  });

  it('should record numeric index followed by property access', () => {
    const proxy = createProxy<ContextWithArray>();
    const ref = proxy.scenes[0].start_seconds;
    expect(ref[REF_PATH]).toEqual(['$', 'scenes', '[0]', 'start_seconds']);
  });

  it('should handle tuple indexing with nested tuples', () => {
    const proxy = createProxy<ContextWithTuple>();
    const ref =
      proxy.processScene[0].generateDescriptions[2].thumbnailStorageRef;
    expect(ref[REF_PATH]).toEqual([
      '$',
      'processScene',
      '[0]',
      'generateDescriptions',
      '[2]',
      'thumbnailStorageRef',
    ]);
  });

  it('should handle consecutive array accesses', () => {
    type Nested = { matrix: number[][] };
    const proxy = createProxy<Nested>();
    const ref = proxy.matrix[1][2];
    expect(ref[REF_PATH]).toEqual(['$', 'matrix', '[1]', '[2]']);
  });

  it('should accept a custom initial path', () => {
    const proxy = createProxy<SimpleContext>(['$', 'existing', 'path']);
    const ref = proxy.jobId;
    expect(ref[REF_PATH]).toEqual(['$', 'existing', 'path', 'jobId']);
  });

  it('should not share state between different access chains', () => {
    const proxy = createProxy<SimpleContext>();
    const ref1 = proxy.fileUpload.id;
    const ref2 = proxy.fileUpload.filename;
    const ref3 = proxy.bucket;
    expect(ref1[REF_PATH]).toEqual(['$', 'fileUpload', 'id']);
    expect(ref2[REF_PATH]).toEqual(['$', 'fileUpload', 'filename']);
    expect(ref3[REF_PATH]).toEqual(['$', 'bucket']);
  });
});

// ── pathOf ──────────────────────────────────────────────────────────

describe('pathOf', () => {
  it('should return "$" for the root proxy', () => {
    const proxy = createProxy<SimpleContext>();
    expect(pathOf(proxy)).toBe('$');
  });

  it('should produce a dot-separated path for nested properties', () => {
    const proxy = createProxy<SimpleContext>();
    expect(pathOf(proxy.fileUpload.organizationId)).toBe(
      '$.fileUpload.organizationId',
    );
  });

  it('should attach array indices without a dot', () => {
    const proxy = createProxy<ContextWithArray>();
    expect(pathOf(proxy.scenes[0].start_seconds)).toBe(
      '$.scenes[0].start_seconds',
    );
  });

  it('should handle consecutive array indices', () => {
    type Nested = { matrix: number[][] };
    const proxy = createProxy<Nested>();
    expect(pathOf(proxy.matrix[1][2])).toBe('$.matrix[1][2]');
  });

  it('should handle the full parallel branch path pattern', () => {
    const proxy = createProxy<ContextWithTuple>();
    expect(
      pathOf(proxy.processScene[0].generateDescriptions[2].thumbnailStorageRef),
    ).toBe('$.processScene[0].generateDescriptions[2].thumbnailStorageRef');
  });

  it('should handle mixed property and index access', () => {
    const proxy = createProxy<ContextWithTuple>();
    expect(pathOf(proxy.processScene[1].transcodePreview.storageRef)).toBe(
      '$.processScene[1].transcodePreview.storageRef',
    );
  });

  it('should produce single-level path', () => {
    const proxy = createProxy<SimpleContext>();
    expect(pathOf(proxy.jobId)).toBe('$.jobId');
  });

  it('should handle deeply nested paths', () => {
    const proxy = createProxy<DeeplyNested>();
    expect(pathOf(proxy.a.b.c.d.value)).toBe('$.a.b.c.d.value');
  });
});

// ── isRef ───────────────────────────────────────────────────────────

describe('isRef', () => {
  it('should return true for a proxy', () => {
    const proxy = createProxy<SimpleContext>();
    expect(isRef(proxy)).toBe(true);
  });

  it('should return true for a nested proxy access', () => {
    const proxy = createProxy<SimpleContext>();
    expect(isRef(proxy.fileUpload.storage)).toBe(true);
  });

  it('should return false for a plain string', () => {
    expect(isRef('$.foo.bar')).toBe(false);
  });

  it('should return false for a plain object', () => {
    expect(isRef({ bucket: 'b', key: 'k' })).toBe(false);
  });

  it('should return false for null', () => {
    expect(isRef(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isRef(undefined)).toBe(false);
  });

  it('should return false for a number', () => {
    expect(isRef(42)).toBe(false);
  });
});

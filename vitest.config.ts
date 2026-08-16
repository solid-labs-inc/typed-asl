import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tutorial/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // path.ts is type-only; its emitted JS is empty and v8 reports it
      // as 0%, which would just distort the numbers.
      exclude: ['src/**/*.test.ts', 'src/lib/path.ts'],
      // Ratchet thresholds: set just below the current measured level.
      // When coverage rises meaningfully, raise these — never lower them.
      thresholds: {
        statements: 96,
        branches: 92,
        functions: 97,
        lines: 96,
      },
    },
  },
});

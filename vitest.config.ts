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
      // When coverage rises meaningfully, raise these; only lower them to
      // re-baseline after a coverage-tool major bump changes attribution
      // (last: vitest 3 → 4, which measured ~1pt lower on identical code).
      thresholds: {
        statements: 95,
        branches: 91,
        functions: 96,
        lines: 96,
      },
    },
  },
});

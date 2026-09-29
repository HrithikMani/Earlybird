import { defineConfig } from 'vitest/config';

// Unit tests live in test/; Playwright e2e specs (e2e/) are run by `npm run test:e2e`.
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.js'],
    exclude: ['node_modules/**', 'e2e/**', 'web/**'],
  },
});

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'bench/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/fixtures/**', '**/.claude/**'],
    testTimeout: 120_000,
  },
})

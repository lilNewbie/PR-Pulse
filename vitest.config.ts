import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      shared: resolve(__dirname, 'shared/types.ts'),
    },
  },
})

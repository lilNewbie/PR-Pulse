
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { configDotenv } from 'dotenv'

configDotenv()

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // Tests share the same PostgreSQL database.
    // Prevent parallel test files from truncating each other's data.
    fileParallelism: false,

    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30000,

    env: {
      // Dedicated test database: never use the development database.
      DATABASE_URL:
        'postgres://postgres:postgres@localhost:5433/pr_pulse_test',

      TOKEN_KEY:
        process.env.TOKEN_KEY ??
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',

      SESSION_SECRET:
        process.env.SESSION_SECRET ??
        'test-session-secret-for-testing!!',

      GITHUB_CLIENT_ID:
        process.env.GITHUB_CLIENT_ID ?? 'test-client-id',

      GITHUB_CLIENT_SECRET:
        process.env.GITHUB_CLIENT_SECRET ?? 'test-client-secret',

      APP_URL: '',
      NODE_ENV: 'test',
    },
  },

  resolve: {
    alias: {
      shared: resolve(__dirname, 'shared/types.ts'),
    },
  },
})

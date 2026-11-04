import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { configDotenv } from 'dotenv'

configDotenv() // loads .env if present — makes DATABASE_URL available for fallback below

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/pr_pulse',
      TOKEN_KEY: process.env.TOKEN_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      SESSION_SECRET: process.env.SESSION_SECRET ?? 'test-session-secret-for-testing!!',
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? 'test-client-id',
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? 'test-client-secret',
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

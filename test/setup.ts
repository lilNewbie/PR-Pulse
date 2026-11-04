import { beforeAll, afterAll } from 'vitest'
import pool from '../server/src/db/pool'

beforeAll(async () => {
  const { rows } = await pool.query<{ database_name: string }>(
    'SELECT current_database() AS database_name',
  )

  if (rows[0]?.database_name !== 'pr_pulse_test') {
    throw new Error(
      `Unsafe test database: ${rows[0]?.database_name}. Expected pr_pulse_test.`,
    )
  }
})

afterAll(async () => {
  await pool.end()
})
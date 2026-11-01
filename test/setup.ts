import { afterAll } from 'vitest'
import pool from '../server/src/db/pool'

afterAll(async () => {
  await pool.end()
})

import { Pool } from 'pg'
import { configDotenv } from 'dotenv'
import { resolve } from 'path'

// Import statements are hoisted by TypeScript's CJS compiler, but the function
// call below runs before `new Pool()` because both are in the module body.
// This ensures DATABASE_URL is set before the pool is created.
configDotenv({ path: resolve(__dirname, '../../../.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

export default pool

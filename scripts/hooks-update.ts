// npm run hooks:update
// Patches the webhook of every connected repo so it subscribes to the full event list
// (adds deployment_status for US-12). Safe to run more than once.
import 'dotenv/config'
import pool from '../server/src/db/pool'
import { updateAllHooks } from '../server/src/modules/team-repo/hooksUpdate'

async function main(): Promise<void> {
  try {
    const { updated, failed } = await updateAllHooks()
    console.log(`hooks:update done: ${updated} updated, ${failed} failed`)
    if (failed > 0) process.exitCode = 1
  } catch (err) {
    console.error('hooks:update failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

void main()

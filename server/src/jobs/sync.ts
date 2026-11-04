import pool from '../db/pool'
import { listConnectedRepoIds } from '../db/repos'
import { syncRepo } from '../sync'

export async function runScheduledSync(): Promise<void> {
  const repoIds = await listConnectedRepoIds()

  for (const repoId of repoIds) {
    try {
      const result = await syncRepo(repoId, 'scheduled')
      console.log(
        `[scheduled-sync] repo=${repoId} status=${result.status} upserted=${result.prsUpserted} closed=${result.prsClosed}`,
      )
    } catch (error) {
      console.error(
        `[scheduled-sync] repo=${repoId} failed:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

if (process.argv[1]?.replace(/\\/g, '/').match(/\/jobs\/sync\.(ts|js)$/)) {
  runScheduledSync()
    .catch((error) => {
      console.error('[scheduled-sync] database unavailable:', error)
      process.exitCode = 1
    })
    .finally(async () => {
      await pool.end()
    })
}



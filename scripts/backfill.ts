// npm run backfill
// Loads default-branch commit history into file_touches for every connected repo (US-11, US-15).
// Repos connected from now on are backfilled by their initial sync. Safe to run more than once:
// a repo that hit the rate limit resumes where it stopped, and stored touches are never duplicated.
import 'dotenv/config'
import pool from '../server/src/db/pool'
import { listConnectedRepoIds } from '../server/src/db/repos'
import { backfillFileTouches } from '../server/src/sync'

async function main(): Promise<void> {
  let failed = 0
  try {
    for (const repoId of await listConnectedRepoIds()) {
      try {
        const { commits, files } = await backfillFileTouches(repoId)
        console.log(`backfill: repo ${repoId}: ${commits} commits, ${files} file touches`)
      } catch (err) {
        failed++
        console.error(`backfill: repo ${repoId} failed:`, err instanceof Error ? err.message : err)
      }
    }
  } catch (err) {
    failed++
    console.error('backfill failed:', err instanceof Error ? err.message : err)
  } finally {
    await pool.end()
  }
  if (failed > 0) process.exitCode = 1
}

void main()

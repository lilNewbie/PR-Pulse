import { Router } from 'express'
import type { QueueResponse } from 'shared'
import { requireRole } from '../../middleware/requireRole'
import { listQueueRows } from '../../db/prs'
import { listAccessibleRepoSyncStatus } from '../../db/repos'
import { rankQueue } from './rank'

const router = Router()

router.get('/api/queue', requireRole('reviewer'), (req, res, next) => {
  handleQueue(req, res).catch(next)
})

async function handleQueue(
  req: Parameters<Router>[0],
  res: Parameters<Router>[1],
): Promise<void> {
  const [rows, repoRows] = await Promise.all([
    listQueueRows(req.user!.id),
    listAccessibleRepoSyncStatus(req.user!.id),
  ])
  const items = rankQueue(rows, req.user!, new Date())

  const syncWarning = repoRows.some((r) => r.sync_status !== 'ok')
  const lastSyncedAt = repoRows.reduce<Date | null>((min, r) => {
    if (!r.last_synced_at) return min
    if (!min || r.last_synced_at < min) return r.last_synced_at
    return min
  }, null)

  const body: QueueResponse = {
    items,
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    syncWarning,
  }
  res.json(body)
}

export default router

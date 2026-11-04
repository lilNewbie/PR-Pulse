import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireRole } from '../../middleware/requireRole'
import { requireSession } from '../../middleware/session'
import { listTeamRepos, type RepoRow } from '../../db/repos'
import { connectRepo } from './connect'

// TODO (Alan): move to shared/types.ts so the client can import it.
export interface RepoSummary {
  id: number
  fullName: string
  status: RepoRow['status']
  syncStatus: RepoRow['sync_status']
  lastSyncedAt: string | null
}

// GitHub owner and repo names; also keeps the request path on the repo endpoint.
const githubName = z.string().regex(/^[A-Za-z0-9_.-]+$/)
const connectBody = z.object({ owner: githubName, name: githubName })

const router = Router()

router.get('/api/repos', requireSession, (req, res, next) => {
  listTeamRepos(req.user!.id)
    .then((rows) => res.json({ items: rows.map(toSummary) }))
    .catch(next)
})

router.post('/api/repos', requireRole('lead'), (req, res, next) => {
  handleConnect(req, res).catch(next)
})

async function handleConnect(req: Request, res: Response): Promise<void> {
  const body = connectBody.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ error: 'owner and name are required' })
    return
  }

  const result = await connectRepo(req.user!.id, body.data.owner, body.data.name)
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(202).json({ repoId: result.repoId, status: 'connecting' })
}

function toSummary(row: RepoRow): RepoSummary {
  return {
    id: Number(row.id),
    fullName: `${row.owner}/${row.name}`,
    status: row.status,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
  }
}

export default router

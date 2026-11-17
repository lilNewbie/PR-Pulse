import { Router } from 'express'
import { z } from 'zod'
import type { DeploymentDetail } from 'shared'
import { requireRole } from '../../middleware/requireRole'
import { getDeploymentDetail, insertManualDeployment, DuplicateDeploymentError } from '../../db/deploymentWrites'
import pool from '../../db/pool'
import { linkDeployment } from '.'

const router = Router()

// GET /api/deployments/:id — Lead only, repo-access enforced in DB query
router.get('/api/deployments/:id', requireRole('lead'), async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'Deployment not found' })
      return
    }

    const result = await getDeploymentDetail(req.user!.id, id)
    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Deployment not found' })
      return
    }
    if (result.status === 'forbidden') {
      res.status(403).json({ error: "You don't have access to this repository" })
      return
    }

    const body: DeploymentDetail = result.detail
    res.json(body)
  } catch (err) {
    next(err)
  }
})

// POST /api/deployments — Lead only (US-16, never previously landed)
const postSchema = z.object({
  repoId: z.number().int().positive(),
  sha: z.string().min(1),
  environment: z.enum(['staging', 'production']),
})

router.post('/api/deployments', requireRole('lead'), async (req, res, next) => {
  try {
    const body = postSchema.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'repoId, sha and environment are required' })
      return
    }

    const { repoId, sha, environment } = body.data

    // Enforce repo access
    const { rows } = await pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM repo_access WHERE user_id = $1 AND repo_id = $2
       ) AS allowed`,
      [req.user!.id, repoId],
    )
    if (!rows[0]?.allowed) {
      res.status(403).json({ error: "You don't have access to this repository" })
      return
    }

    let deploymentId: number
    try {
      deploymentId = await insertManualDeployment({
        repoId, sha, environment, recordedBy: req.user!.id,
      })
    } catch (err) {
      if (err instanceof DuplicateDeploymentError) {
        res.status(409).json({ error: err.message })
        return
      }
      throw err
    }

    // Link in the background — don't block the response on a GitHub call
    linkDeployment(deploymentId).catch((err: unknown) => {
      console.error(
        `deployments: link failed for manual deployment ${deploymentId}:`,
        err instanceof Error ? err.message : err,
      )
    })

    res.status(201).json({ id: deploymentId })
  } catch (err) {
    next(err)
  }
})

export default router

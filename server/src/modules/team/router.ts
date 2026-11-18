// US-18: Lead-only Team bottleneck API, mounted via Mallikarjun's PR router.
import { Router } from 'express'
import { z } from 'zod'
import { requireRole } from '../../middleware/requireRole'
import { getTeamBottlenecks } from '.'

const querySchema = z.object({
  repoId: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger).optional(),
})

const router = Router()

router.get('/api/team/bottlenecks', requireRole('lead'), async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid repoId' })
    return
  }

  try {
    const result = await getTeamBottlenecks(req.user!.id, parsed.data.repoId)
    if (result.status === 'forbidden') {
      res.status(403).json({ error: "You don't have access to this repository" })
      return
    }
    res.status(200).json(result.body)
  } catch (error) {
    next(error)
  }
})

export default router

// US-13 list route. Mounted through the PRs router to keep changes within
// Mallikarjun's owned paths; Alan owns deployment detail routes and the app shell.
import { Router } from 'express'
import { z } from 'zod'
import { requireRole } from '../../middleware/requireRole'
import { getDeployments } from '../../db/deployments'

const querySchema = z.object({
  repoId: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger),
  environment: z.enum(['staging', 'production']).optional(),
})

const router = Router()

router.get('/api/deployments', requireRole('lead'), async (req, res, next) => {
  const query = querySchema.safeParse(req.query)
  if (!query.success) {
    res.status(400).json({ error: 'Invalid repoId or environment' })
    return
  }

  try {
    const result = await getDeployments(
      req.user!.id,
      query.data.repoId,
      query.data.environment,
    )

    if (result.status === 'forbidden') {
      res.status(403).json({ error: "You don't have access to this repository" })
      return
    }

    res.status(200).json(result.items)
  } catch (error) {
    next(error)
  }
})

export default router

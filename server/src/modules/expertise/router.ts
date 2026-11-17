// Owned by Kaushik. GET /api/me/expertise?repoId= (US-15, design-final section 3).
import { Router } from 'express'
import { z } from 'zod'
import { requireRole } from '../../middleware/requireRole'
import { getMyExpertise } from '.'

const querySchema = z.object({
  repoId: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger),
})

const router = Router()

// Any role. No session: 401 from the middleware.
router.get('/api/me/expertise', requireRole('pr_author'), async (req, res, next) => {
  const query = querySchema.safeParse(req.query)
  if (!query.success) {
    res.status(400).json({ error: 'repoId is required' })
    return
  }

  try {
    const result = await getMyExpertise(req.user!, query.data.repoId)
    if (result.status === 'forbidden') {
      res.status(403).json({ error: "You don't have access to this repository" })
      return
    }
    res.json(result.body)
  } catch (err) {
    next(err)
  }
})

export default router

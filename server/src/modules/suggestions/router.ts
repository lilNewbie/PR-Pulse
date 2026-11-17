// Owned by Mandaar. GET /api/suggestions (US-11, US-19) and POST /api/suggestions/:prId/dismiss (US-20).
import { Router } from 'express'
import { z } from 'zod'
import type { SuggestionItem } from 'shared'
import { requireRole } from '../../middleware/requireRole'
import { dismissSuggestion, getSuggestions } from '.'

const router = Router()

// Reviewer or Lead. A PR Author gets 403 from the middleware (US-11 AC7).
router.get('/api/suggestions', requireRole('reviewer'), (req, res, next) => {
  getSuggestions(req.user!.id)
    .then((items: SuggestionItem[]) => {
      res.json(items)
    })
    .catch(next)
})

const prIdSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger)
const bodySchema = z.object({ path: z.string().min(1) })

// Reviewer or Lead; a PR Author gets 403 and no session 401 from the middleware (US-20 AC5).
// 404 unknown PR, 403 no access to its repo, 400 path missing or not one of its changed files, else 204.
router.post('/api/suggestions/:prId/dismiss', requireRole('reviewer'), async (req, res, next) => {
  const prId = prIdSchema.safeParse(req.params.prId)
  if (!prId.success) {
    res.status(404).json({ error: 'Pull request not found' })
    return
  }
  const body = bodySchema.safeParse(req.body)
  if (!body.success) {
    res.status(400).json({ error: 'path is required' })
    return
  }

  try {
    const result = await dismissSuggestion(req.user!.id, prId.data, body.data.path)
    if (result === 'not_found') {
      res.status(404).json({ error: 'Pull request not found' })
    } else if (result === 'forbidden') {
      res.status(403).json({ error: "You don't have access to this repository" })
    } else if (result === 'bad_path') {
      res.status(400).json({ error: 'path is not a changed file of this pull request' })
    } else {
      res.status(204).end()
    }
  } catch (err) {
    next(err)
  }
})

export default router

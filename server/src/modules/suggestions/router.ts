// Owned by Mandaar. GET /api/suggestions (US-11, design-final section 3).
import { Router } from 'express'
import type { SuggestionItem } from 'shared'
import { requireRole } from '../../middleware/requireRole'
import { getSuggestions } from '.'

const router = Router()

// Reviewer or Lead. A PR Author gets 403 from the middleware (US-11 AC7).
router.get('/api/suggestions', requireRole('reviewer'), (req, res, next) => {
  getSuggestions(req.user!.id)
    .then((items: SuggestionItem[]) => {
      res.json(items)
    })
    .catch(next)
})

export default router

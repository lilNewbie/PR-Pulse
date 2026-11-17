import { Router } from 'express'
import { requireRole } from '../../middleware/requireRole'
import { getWaitingOn } from '.'

const router = Router()

router.get('/api/my-prs/waiting', requireRole('pr_author'), async (req, res, next) => {
  try {
    const items = await getWaitingOn(req.user!.id)
    res.json(items)
  } catch (err) {
    next(err)
  }
})

export default router

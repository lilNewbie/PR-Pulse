
import { Router } from 'express'
import { requireSession } from '../../middleware/session'
import { getPrForUser } from '../../db/prs'

const router = Router()

router.get('/api/my-prs/:id', requireSession, (req, res, next) => {
  const rawId = req.params.id

  // Validate the PR ID before querying the database.
  if (
    typeof rawId !== 'string' ||
    !/^[1-9]\d*$/.test(rawId)
  ) {
    res.status(400).json({ error: 'Invalid PR ID' })
    return
  }

  const prId = Number(rawId)

  if (!Number.isSafeInteger(prId)) {
    res.status(400).json({ error: 'Invalid PR ID' })
    return
  }

  const userId = req.user!.id

  getPrForUser(userId, prId)
    .then((result) => {
      if (result === 'not_found') {
        res.status(404).json({ error: 'PR not found' })
        return
      }

      if (result === 'forbidden') {
        res.status(403).json({ error: 'Forbidden' })
        return
      }

      res.status(200).json(result)
    })
    .catch(next)
})

export default router

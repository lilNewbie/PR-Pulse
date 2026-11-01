import { RequestHandler } from 'express'
import type { Role } from 'shared'
import { requireSession } from './session'

const ROLE_ORDER: Role[] = ['pr_author', 'reviewer', 'lead']

export function requireRole(min: Role): RequestHandler {
  return (req, res, next) => {
    requireSession(req, res, () => {
      const user = req.user
      if (!user) {
        res.status(401).json({ error: 'Not signed in' })
        return
      }
      if (ROLE_ORDER.indexOf(user.role) < ROLE_ORDER.indexOf(min)) {
        res.status(403).json({ error: `Requires ${min}` })
        return
      }
      next()
    })
  }
}

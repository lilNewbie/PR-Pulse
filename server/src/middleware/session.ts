import { Request, Response, NextFunction, RequestHandler } from 'express'
import type { Role } from 'shared'
import { findSession } from '../db/sessions'
import { findUserById } from '../db/users'
import { getMemberRole } from '../db/members'

export interface SessionUser {
  id: number
  githubId: number
  login: string
  role: Role
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser
    }
  }
}

export const requireSession: RequestHandler = (req, res, next) => {
  run(req, res, next).catch(next)
}

async function run(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.cookies?.['session'] as string | undefined
  if (!sessionId) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }

  const session = await findSession(sessionId)
  if (!session || session.expires_at < new Date()) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }

  const user = await findUserById(session.user_id)
  if (!user) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }

  const role = await getMemberRole(user.id)
  if (!role) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }

  req.user = { id: Number(user.id), githubId: Number(user.github_id), login: user.login, role }
  next()
}

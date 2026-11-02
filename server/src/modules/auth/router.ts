import { Router } from 'express'
import crypto from 'crypto'
import type { Role } from 'shared'
import { requireSession } from '../../middleware/session'
import { buildAuthUrl, exchangeCode, getGithubUser, listUserRepoIds } from './github'
import { upsertUser } from '../../db/users'
import { createSession, deleteSession } from '../../db/sessions'
import { getTeamId, createTeam, upsertMember, countTeamMembers } from '../../db/members'
import { encrypt } from '../../lib/crypto'
import { refreshRepoAccess, needsRepoRefresh, getUserAccessibleRepos } from '../../db/repo_access'
import { getGitHubToken } from './token'

const SESSION_MS = 14 * 24 * 60 * 60 * 1000
const COOKIE_OPTS_BASE = {
  httpOnly: true,
  sameSite: 'lax' as const,
}

const router = Router()

router.get('/auth/github/login', (_req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  res.cookie('oauth_state', state, {
    ...COOKIE_OPTS_BASE,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 10 * 60 * 1000,
  })
  res.redirect(buildAuthUrl(state))
})

router.get('/auth/github/callback', (req, res, next) => {
  handleCallback(req, res).catch(next)
})

async function handleCallback(
  req: Parameters<Router>[0],
  res: Parameters<Router>[1],
): Promise<void> {
  const { code, error, state } = req.query as Record<string, string | undefined>

  if (error === 'access_denied') {
    res.redirect('/signin?cancelled=1')
    return
  }

  const cookieState = req.cookies?.['oauth_state'] as string | undefined
  if (!state || !cookieState || state !== cookieState) {
    res.status(400).json({ error: 'Invalid state parameter' })
    return
  }
  res.clearCookie('oauth_state')

  if (!code) {
    res.redirect('/signin?cancelled=1')
    return
  }

  const accessToken = await exchangeCode(code)
  const ghUser = await getGithubUser(accessToken)
  const user = await upsertUser(ghUser.id, ghUser.login, encrypt(accessToken))

  let teamId = await getTeamId()
  let role: Role
  if (teamId === null) {
    teamId = await createTeam('Default Team')
    role = 'lead'
  } else {
    const count = await countTeamMembers(teamId)
    role = count === 0 ? 'lead' : 'reviewer'
  }
  await upsertMember(teamId, Number(user.id), role)

  const repoIds = await listUserRepoIds(accessToken)
  await refreshRepoAccess(Number(user.id), repoIds)

  const sessionId = crypto.randomBytes(32).toString('hex')
  await createSession(sessionId, Number(user.id), new Date(Date.now() + SESSION_MS))
  res.cookie('session', sessionId, {
    ...COOKIE_OPTS_BASE,
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MS,
  })

  const appUrl = process.env.APP_URL ?? ''
  res.redirect(`${appUrl}/my-prs`)
}

router.post('/auth/logout', requireSession, (req, res, next) => {
  const sessionId = req.cookies?.['session'] as string
  deleteSession(sessionId)
    .then(() => {
      res.clearCookie('session')
      res.status(204).end()
    })
    .catch(next)
})

router.get('/api/me', requireSession, (req, res, next) => {
  handleMe(req, res).catch(next)
})

async function handleMe(
  req: Parameters<Router>[0],
  res: Parameters<Router>[1],
): Promise<void> {
  const user = req.user!

  if (await needsRepoRefresh(user.id)) {
    const token = await getGitHubToken(user.id)
    const repoIds = await listUserRepoIds(token)
    await refreshRepoAccess(user.id, repoIds)
  }

  const repos = await getUserAccessibleRepos(user.id)
  res.json({ id: user.id, login: user.login, role: user.role, repos })
}

export default router

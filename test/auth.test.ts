import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'

vi.mock('../server/src/modules/auth/github', () => ({
  buildAuthUrl: (state: string) =>
    `https://github.com/login/oauth/authorize?client_id=test&state=${state}`,
  exchangeCode: vi.fn(),
  getGithubUser: vi.fn(),
  listUserRepoIds: vi.fn(),
}))

import * as github from '../server/src/modules/auth/github'

const GITHUB_USER = { id: 12345, login: 'testuser' }

async function cleanTables() {
  await pool.query(
    'TRUNCATE TABLE repo_access, sessions, members, users, teams RESTART IDENTITY CASCADE',
  )
}

async function createUserWithSession(opts: { role?: string; githubId?: number } = {}) {
  const { role = 'reviewer', githubId = 12345 } = opts
  const tokenEnc = encrypt('fake-gh-token')
  const {
    rows: [team],
  } = await pool.query<{ id: number }>('INSERT INTO teams (name) VALUES ($1) RETURNING id', [
    'Test Team',
  ])
  const {
    rows: [user],
  } = await pool.query<{ id: number }>(
    'INSERT INTO users (github_id, login, github_token_enc) VALUES ($1, $2, $3) RETURNING id',
    [githubId, 'testuser', tokenEnc],
  )
  await pool.query('INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, $3)', [
    team.id,
    user.id,
    role,
  ])
  const sessionId = 'test-session-' + Math.random().toString(36).slice(2)
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [
    sessionId,
    user.id,
    expiresAt,
  ])
  return { userId: user.id, sessionId, teamId: team.id }
}

async function loginViaOAuth() {
  const agent = request.agent(app)
  const loginRes = await agent.get('/auth/github/login').redirects(0)
  const state = new URL(loginRes.headers['location'] as string).searchParams.get('state')!
  await agent.get(`/auth/github/callback?code=testcode&state=${state}`).redirects(0)
  return agent
}

describe('US-01 Sign in with GitHub', () => {
  beforeEach(async () => {
    await cleanTables()
    vi.mocked(github.exchangeCode).mockResolvedValue('ghs_test123')
    vi.mocked(github.getGithubUser).mockResolvedValue(GITHUB_USER)
    vi.mocked(github.listUserRepoIds).mockResolvedValue([])
  })

  it('US-01 AC1: valid callback creates account and redirects to /my-prs', async () => {
    const agent = request.agent(app)
    const loginRes = await agent.get('/auth/github/login').redirects(0)
    expect(loginRes.status).toBe(302)

    const state = new URL(loginRes.headers['location'] as string).searchParams.get('state')!

    const callbackRes = await agent
      .get(`/auth/github/callback?code=testcode&state=${state}`)
      .redirects(0)

    expect(callbackRes.status).toBe(302)
    expect(callbackRes.headers['location']).toBe('/my-prs')

    const cookies = callbackRes.headers['set-cookie'] as string[]
    expect(cookies?.some((c: string) => c.startsWith('session='))).toBe(true)

    const { rows } = await pool.query('SELECT login FROM users WHERE github_id = $1', [12345])
    expect(rows[0]?.login).toBe('testuser')
  })

  it('US-01 AC2: access_denied redirects to /signin?cancelled=1, no user created', async () => {
    const res = await request(app)
      .get('/auth/github/callback?error=access_denied')
      .redirects(0)

    expect(res.status).toBe(302)
    expect(res.headers['location']).toBe('/signin?cancelled=1')

    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM users')
    expect(Number(rows[0].count)).toBe(0)
  })

  it('US-01 AC3: no connected repo access — /api/me returns repos: []', async () => {
    const agent = await loginViaOAuth()
    vi.mocked(github.listUserRepoIds).mockResolvedValue([])

    const meRes = await agent.get('/api/me')

    expect(meRes.status).toBe(200)
    expect(meRes.body.repos).toEqual([])
    expect(meRes.body.login).toBe('testuser')
  })

  it('US-01 AC4: no session — /api/me returns 401', async () => {
    const res = await request(app).get('/api/me')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Not signed in' })
  })

  it('POST /auth/logout: 401 without session', async () => {
    const res = await request(app).post('/auth/logout')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Not signed in' })
  })

  it('POST /auth/logout: 204 with valid session and clears cookie', async () => {
    const { sessionId } = await createUserWithSession()

    const res = await request(app).post('/auth/logout').set('Cookie', `session=${sessionId}`)

    expect(res.status).toBe(204)

    const { rows } = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId])
    expect(rows.length).toBe(0)
  })
})

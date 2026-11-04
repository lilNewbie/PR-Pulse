import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import nock from 'nock'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { decrypt, encrypt } from '../server/src/lib/crypto'
import { syncRepo } from '../server/src/sync'

vi.mock('../server/src/sync', () => ({
  syncRepo: vi.fn().mockResolvedValue({ status: 'ok', prsUpserted: 0, prsClosed: 0, lastSyncedAt: null }),
}))

const GITHUB_API = 'https://api.github.com'
const TOKEN = 'gh-lead-token'
const WEBHOOK_URL = 'https://pr-pulse.test/webhooks/github'
const GITHUB_REPO = { id: 4242, owner: { login: 'acme' }, name: 'api', permissions: { admin: true } }

process.env.WEBHOOK_URL = WEBHOOK_URL

async function cleanTables() {
  await pool.query(
    'TRUNCATE TABLE repo_access, repos, sessions, members, users, teams RESTART IDENTITY CASCADE',
  )
}

async function createTeam(name = 'Test Team'): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO teams (name) VALUES ($1) RETURNING id',
    [name],
  )
  return Number(rows[0].id)
}

async function signIn(teamId: number, role: string, githubId: number) {
  const {
    rows: [user],
  } = await pool.query<{ id: string }>(
    'INSERT INTO users (github_id, login, github_token_enc) VALUES ($1, $2, $3) RETURNING id',
    [githubId, `user-${githubId}`, encrypt(TOKEN)],
  )
  await pool.query('INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, $3)', [
    teamId,
    user.id,
    role,
  ])
  const sessionId = `test-session-${githubId}`
  await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [
    sessionId,
    user.id,
    new Date(Date.now() + 60 * 60 * 1000),
  ])
  return { userId: Number(user.id), cookie: `session=${sessionId}` }
}

async function insertRepo(teamId: number, githubRepoId: number, name: string, status = 'connected') {
  await pool.query(
    `INSERT INTO repos
       (team_id, github_repo_id, owner, name, webhook_secret_enc, status, sync_status, last_synced_at)
     VALUES ($1, $2, 'acme', $3, $4, $5, 'ok', $6)`,
    [teamId, githubRepoId, name, encrypt('secret'), status, new Date('2026-11-01T12:00:00Z')],
  )
}

async function countRepos(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM repos')
  return Number(rows[0].count)
}

function mockGetRepo(repo = GITHUB_REPO) {
  return nock(GITHUB_API, { reqheaders: { authorization: `Bearer ${TOKEN}` } })
    .get('/repos/acme/api')
    .reply(200, repo)
}

function connect(cookie: string, body: object = { owner: 'acme', name: 'api' }) {
  return request(app).post('/api/repos').set('Cookie', cookie).send(body)
}

describe('US-05 Connect a repository', () => {
  let teamId: number

  beforeEach(async () => {
    await cleanTables()
    teamId = await createTeam()
    vi.mocked(syncRepo).mockClear()
    nock.disableNetConnect()
    nock.enableNetConnect(/127\.0\.0\.1|localhost/)
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  it('US-05 AC1: Lead with GitHub admin connects a repo', async () => {
    const lead = await signIn(teamId, 'lead', 1001)
    const getScope = mockGetRepo()
    let hookBody: { events: string[]; config: { url: string; secret: string; content_type: string } } | undefined
    const hookScope = nock(GITHUB_API)
      .post('/repos/acme/api/hooks', (body) => {
        hookBody = body
        return true
      })
      .reply(201, { id: 77 })

    const res = await connect(lead.cookie)

    expect(res.status).toBe(202)
    expect(res.body).toEqual({ repoId: expect.any(Number), status: 'connecting' })
    expect(getScope.isDone() && hookScope.isDone()).toBe(true)

    expect(hookBody?.events).toEqual(['pull_request', 'pull_request_review', 'issue_comment', 'push'])
    expect(hookBody?.config).toMatchObject({ url: WEBHOOK_URL, content_type: 'json' })

    const { rows } = await pool.query(
      'SELECT status, hook_id, webhook_secret_enc, connected_by FROM repos WHERE id = $1',
      [res.body.repoId],
    )
    expect(rows[0].status).toBe('connecting')
    expect(Number(rows[0].hook_id)).toBe(77)
    expect(Number(rows[0].connected_by)).toBe(lead.userId)
    expect(decrypt(rows[0].webhook_secret_enc)).toBe(hookBody?.config.secret)

    const access = await pool.query('SELECT 1 FROM repo_access WHERE user_id = $1 AND repo_id = $2', [
      lead.userId,
      res.body.repoId,
    ])
    expect(access.rowCount).toBe(1)

    expect(syncRepo).toHaveBeenCalledWith(res.body.repoId, 'initial')
  })

  it.each(['reviewer', 'pr_author'])('US-05 AC2: %s gets 403 and no GitHub calls', async (role) => {
    const member = await signIn(teamId, role, 1002)
    const getScope = mockGetRepo()

    const res = await connect(member.cookie)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Requires lead' })
    expect(getScope.isDone()).toBe(false)
    expect(await countRepos()).toBe(0)
  })

  it('US-05 AC3: no GitHub admin returns 403, no hook, no row', async () => {
    const lead = await signIn(teamId, 'lead', 1001)
    mockGetRepo({ ...GITHUB_REPO, permissions: { admin: false } })
    const hookScope = nock(GITHUB_API).post('/repos/acme/api/hooks').reply(201, { id: 77 })

    const res = await connect(lead.cookie)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'You need admin access to this repo on GitHub' })
    expect(hookScope.isDone()).toBe(false)
    expect(await countRepos()).toBe(0)
  })

  it('US-05 AC4: already connected returns 409 without a second hook', async () => {
    const lead = await signIn(teamId, 'lead', 1001)
    await insertRepo(teamId, GITHUB_REPO.id, 'api')
    mockGetRepo()
    const hookScope = nock(GITHUB_API).post('/repos/acme/api/hooks').reply(201, { id: 77 })

    const res = await connect(lead.cookie)

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'This repository is already connected' })
    expect(hookScope.isDone()).toBe(false)
    expect(await countRepos()).toBe(1)
  })

  it('US-05 AC5: GitHub 5xx returns 502, nothing stored', async () => {
    const lead = await signIn(teamId, 'lead', 1001)
    nock(GITHUB_API).get('/repos/acme/api').reply(503)

    const res = await connect(lead.cookie)

    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: "Couldn't reach GitHub, try again" })
    expect(await countRepos()).toBe(0)
  })

  it('US-05 AC5: GitHub unreachable returns 502, nothing stored', async () => {
    const lead = await signIn(teamId, 'lead', 1001)
    nock(GITHUB_API).get('/repos/acme/api').replyWithError('connect ETIMEDOUT')

    const res = await connect(lead.cookie)

    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: "Couldn't reach GitHub, try again" })
    expect(await countRepos()).toBe(0)
  })

  it('US-05 AC6: concurrent connects store one row and delete the losing hook', async () => {
    const lead = await signIn(teamId, 'lead', 1001)
    nock(GITHUB_API).get('/repos/acme/api').times(2).reply(200, GITHUB_REPO)
    // Delay hook creation so both requests pass the "already connected" check first.
    nock(GITHUB_API).post('/repos/acme/api/hooks').delay(200).reply(201, { id: 101 })
    nock(GITHUB_API).post('/repos/acme/api/hooks').delay(200).reply(201, { id: 102 })
    const deleted: number[] = []
    nock(GITHUB_API)
      .delete(/^\/repos\/acme\/api\/hooks\/\d+$/)
      .reply(204, (uri) => {
        deleted.push(Number(uri.split('/').pop()))
        return ''
      })

    const results = await Promise.all([connect(lead.cookie), connect(lead.cookie)])

    expect(results.map((r) => r.status).sort()).toEqual([202, 409])
    const { rows } = await pool.query('SELECT hook_id FROM repos')
    expect(rows).toHaveLength(1)
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).not.toBe(Number(rows[0].hook_id))
  })

  it('POST /api/repos: 401 without session', async () => {
    const res = await request(app).post('/api/repos').send({ owner: 'acme', name: 'api' })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Not signed in' })
  })

  it('POST /api/repos: 400 for a missing or invalid name', async () => {
    const lead = await signIn(teamId, 'lead', 1001)

    for (const body of [{ owner: 'acme' }, { owner: 'acme', name: '../users' }]) {
      const res = await connect(lead.cookie, body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'owner and name are required' })
    }
  })
})

describe('GET /api/repos', () => {
  beforeEach(cleanTables)

  it('401 without session', async () => {
    const res = await request(app).get('/api/repos')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Not signed in' })
  })

  it("returns the caller's team repos with status and sync fields", async () => {
    const teamId = await createTeam()
    const otherTeamId = await createTeam('Other Team')
    const reviewer = await signIn(teamId, 'reviewer', 2001)
    await insertRepo(teamId, 1, 'api', 'connecting')
    await insertRepo(otherTeamId, 2, 'secret-project')

    const res = await request(app).get('/api/repos').set('Cookie', reviewer.cookie)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: [
        {
          id: expect.any(Number),
          fullName: 'acme/api',
          status: 'connecting',
          syncStatus: 'ok',
          lastSyncedAt: '2026-11-01T12:00:00.000Z',
        },
      ],
    })
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'
import { recordPushTouches } from '../server/src/sync'
import type { ExpertiseResponse } from 'shared'

const ME = 4001 // reviewer, login "me-dev"
const OTHER = 4002 // reviewer, login "other-dev"
const AUTHOR = 4003 // pr_author, login "author-dev"

let teamId: number
let repoId: number
let hiddenRepoId: number
const users = new Map<number, number>() // github id -> user id

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600_000)

async function createUser(githubId: number, login: string, role: string) {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (github_id, login, github_token_enc) VALUES ($1, $2, $3) RETURNING id',
    [githubId, login, encrypt('test-token')],
  )
  const userId = Number(rows[0].id)
  users.set(githubId, userId)
  await pool.query('INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, $3)', [teamId, userId, role])
}

async function createRepo(githubRepoId: number, name: string) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO repos (team_id, github_repo_id, owner, name, webhook_secret_enc, status, sync_status, last_synced_at)
     VALUES ($1, $2, 'test-org', $3, 'secret', 'connected', 'ok', now()) RETURNING id`,
    [teamId, githubRepoId, name],
  )
  return Number(rows[0].id)
}

async function grantAccess(githubId: number, repo: number) {
  await pool.query('INSERT INTO repo_access (user_id, repo_id, checked_at) VALUES ($1, $2, now())', [
    users.get(githubId),
    repo,
  ])
}

// One commit touching several files.
async function commit(sha: string, login: string, at: Date, paths: string[], repo = repoId) {
  for (const path of paths) {
    await pool.query(
      'INSERT INTO file_touches (repo_id, path, author_login, commit_sha, committed_at) VALUES ($1, $2, $3, $4, $5)',
      [repo, path, login, sha, at],
    )
  }
}

async function sessionFor(githubId: number) {
  const id = `session-${githubId}`
  await pool.query(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day') ON CONFLICT DO NOTHING",
    [id, users.get(githubId)],
  )
  return `session=${id}`
}

function getExpertise(cookie: string | null, query = `?repoId=${repoId}`) {
  const req = request(app).get(`/api/me/expertise${query}`)
  return cookie ? req.set('Cookie', cookie) : req
}

async function expertiseOf(githubId: number): Promise<ExpertiseResponse> {
  const res = await getExpertise(await sessionFor(githubId))
  expect(res.status).toBe(200)
  return res.body
}

describe('US-15 GET /api/me/expertise', () => {
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE file_touches, repo_access, repos, sessions, members, users, teams RESTART IDENTITY CASCADE',
    )
    users.clear()
    const { rows } = await pool.query<{ id: string }>("INSERT INTO teams (name) VALUES ('Team') RETURNING id")
    teamId = Number(rows[0].id)
    await createUser(ME, 'me-dev', 'reviewer')
    await createUser(OTHER, 'other-dev', 'reviewer')
    await createUser(AUTHOR, 'author-dev', 'pr_author')
    repoId = await createRepo(900101, 'api')
    hiddenRepoId = await createRepo(900102, 'secret')
    for (const id of [ME, OTHER, AUTHOR]) await grantAccess(id, repoId)
  })

  it('US-15 AC1: touches across areas → at most 10 areas with correct counts and dates, most recent first', async () => {
    // 12 areas, area i last touched i days ago, so area-1..area-10 are kept, area-11 and area-12 dropped.
    const dates = Array.from({ length: 13 }, (_, i) => daysAgo(i))
    for (let i = 1; i <= 12; i++) await commit(`a${i}`, 'me-dev', dates[i], [`pkg/area-${i}/index.ts`])
    // area-1 gets two more commits, an older one and one with two files.
    await commit('a1-old', 'me-dev', daysAgo(30), ['pkg/area-1/old.ts'])
    await commit('a1-two', 'me-dev', daysAgo(20), ['pkg/area-1/x.ts', 'pkg/area-1/y.ts'])
    // Someone else's commits never count.
    await commit('o1', 'other-dev', daysAgo(0), ['pkg/area-1/index.ts', 'pkg/elsewhere/z.ts'])

    const body = await expertiseOf(ME)

    expect(body.repo).toEqual({ id: repoId, fullName: 'test-org/api' })
    expect(body.areas).toHaveLength(10)
    expect(body.areas.map((a) => a.area)).toEqual(Array.from({ length: 10 }, (_, i) => `pkg/area-${i + 1}`))
    expect(body.areas[0]).toEqual({ area: 'pkg/area-1', commits: 3, lastCommitAt: dates[1].toISOString() })
    expect(body.areas[9]).toEqual({ area: 'pkg/area-10', commits: 1, lastCommitAt: dates[10].toISOString() })
  })

  it('US-15 AC1: an area is the first two directory segments; a top-level file is "/"', async () => {
    await commit('c1', 'me-dev', daysAgo(1), ['src/auth/session.ts', 'src/auth/deep/nested/token.ts'])
    await commit('c2', 'me-dev', daysAgo(2), ['src/index.ts'])
    await commit('c3', 'me-dev', daysAgo(3), ['README.md'])

    const body = await expertiseOf(ME)

    expect(body.areas.map((a) => [a.area, a.commits])).toEqual([
      ['src/auth', 1],
      ['src', 1],
      ['/', 1],
    ])
  })

  it('US-15 AC1: equal dates are ordered by commit count', async () => {
    const at = daysAgo(1)
    await commit('c1', 'me-dev', at, ['lib/a/1.ts'])
    await commit('c2', 'me-dev', at, ['lib/b/1.ts'])
    await commit('c3', 'me-dev', daysAgo(5), ['lib/b/2.ts'])

    const body = await expertiseOf(ME)

    expect(body.areas.map((a) => a.area)).toEqual(['lib/b', 'lib/a'])
  })

  it('US-15 AC2: a new push touching src/auth updates that area\'s count and date', async () => {
    await commit('old', 'me-dev', daysAgo(10), ['src/auth/session.ts'])
    await commit('newer', 'me-dev', daysAgo(2), ['src/queue/rank.ts'])
    const before = await expertiseOf(ME)
    expect(before.areas.map((a) => a.area)).toEqual(['src/queue', 'src/auth'])

    // The push webhook path (Mandaar's recordPushTouches, called from the receiver; the
    // within-1-minute timing is covered in test/webhook.test.ts "push records file touches").
    const pushedAt = new Date()
    await recordPushTouches(repoId, {
      ref: 'refs/heads/main',
      repository: { id: 900101, default_branch: 'main' },
      commits: [
        {
          id: 'pushed1',
          timestamp: pushedAt.toISOString(),
          author: { name: 'Me', email: 'me@example.com', username: 'me-dev' },
          added: ['src/auth/oauth.ts'],
          modified: ['src/auth/session.ts'],
          removed: [],
        },
      ],
    })

    const after = await expertiseOf(ME)
    expect(after.areas[0]).toEqual({ area: 'src/auth', commits: 2, lastCommitAt: pushedAt.toISOString() })
  })

  it('US-15 AC3: no touches → empty areas', async () => {
    await commit('o1', 'other-dev', daysAgo(1), ['src/auth/session.ts'])

    const body = await expertiseOf(ME)

    expect(body).toEqual({ repo: { id: repoId, fullName: 'test-org/api' }, areas: [] })
  })

  it("US-15 AC4: repo I can't access → 403 with no areas; no session → 401; missing repoId → 400", async () => {
    await commit('h1', 'me-dev', daysAgo(1), ['src/auth/session.ts'], hiddenRepoId)
    const cookie = await sessionFor(ME)

    const forbidden = await getExpertise(cookie, `?repoId=${hiddenRepoId}`)
    expect(forbidden.status).toBe(403)
    expect(forbidden.body).toEqual({ error: "You don't have access to this repository" })

    const unknown = await getExpertise(cookie, '?repoId=999999')
    expect(unknown.status).toBe(403)

    expect((await getExpertise(null)).status).toBe(401)

    for (const query of ['', '?repoId=', '?repoId=abc', '?repoId=0']) {
      const res = await getExpertise(cookie, query)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'repoId is required' })
    }
  })

  it('US-15 AC4: every role can call it (PR Author included)', async () => {
    await commit('p1', 'author-dev', daysAgo(1), ['web/pages/home.tsx'])

    const body = await expertiseOf(AUTHOR)

    expect(body.areas).toEqual([{ area: 'web/pages', commits: 1, lastCommitAt: expect.any(String) }])
  })

  it('US-15 AC5: one commit touching 3 files in one area counts once', async () => {
    const at = daysAgo(1)
    await commit('c1', 'me-dev', at, ['src/auth/a.ts', 'src/auth/b.ts', 'src/auth/c.ts'])

    const body = await expertiseOf(ME)

    expect(body.areas).toEqual([{ area: 'src/auth', commits: 1, lastCommitAt: at.toISOString() }])
  })
})

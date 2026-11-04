import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'
import type { Role } from 'shared'

type TestUser = {
  sessionId: string
  userId: number
}

let users: Record<Role, TestUser>

async function createUser(
  teamId: number,
  role: Role,
  githubId: number,
): Promise<TestUser> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (github_id, login, github_token_enc)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [githubId, `permission_${role}`, encrypt('test-token')],
  )

  const userId = Number(rows[0].id)

  await pool.query(
    `INSERT INTO members (team_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [teamId, userId, role],
  )

  const sessionId = `permission-${role}-${userId}`

  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [sessionId, userId],
  )

  return { userId, sessionId }
}

describe('Day 6 permission matrix', () => {
  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        webhook_events, reviews, review_requests,
        pull_requests, repo_access, repos,
        sessions, members, users, teams
      RESTART IDENTITY CASCADE
    `)

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO teams (name)
       VALUES ('Permission Test Team')
       RETURNING id`,
    )

    const teamId = Number(rows[0].id)

    users = {
      pr_author: await createUser(teamId, 'pr_author', 81001),
      reviewer: await createUser(teamId, 'reviewer', 81002),
      lead: await createUser(teamId, 'lead', 81003),
    }

    // Provide fresh repository access so /api/me does not
    // attempt a real GitHub refresh using fake test tokens.
    const { rows: repos } = await pool.query<{ id: number }>(
      `INSERT INTO repos
        (team_id, github_repo_id, owner, name,
         webhook_secret_enc, status, sync_status)
       VALUES
        ($1, 99001, 'permission-org', 'permission-repo',
         'test-secret', 'connected', 'ok')
       RETURNING id`,
      [teamId],
    )

    for (const role of ['pr_author', 'reviewer', 'lead'] as const) {
      await pool.query(
        `INSERT INTO repo_access (user_id, repo_id, checked_at)
         VALUES ($1, $2, NOW())`,
        [users[role].userId, repos[0].id],
      )
    }
  })

  const protectedGetRoutes = [
    '/api/me',
    '/api/my-prs',
    '/api/my-prs/1',
    '/api/queue',
    '/api/repos',
  ]

  for (const route of protectedGetRoutes) {
    it(`returns 401 without a session: GET ${route}`, async () => {
      const response = await request(app).get(route)
      expect(response.status).toBe(401)
    })
  }

  it('returns 401 without a session: POST /api/repos', async () => {
    const response = await request(app).post('/api/repos').send({})
    expect(response.status).toBe(401)
  })

  it('returns 401 without a session: POST /auth/logout', async () => {
    const response = await request(app).post('/auth/logout')
    expect(response.status).toBe(401)
  })

  for (const role of ['pr_author', 'reviewer', 'lead'] as const) {
    it(`allows ${role} to access /api/me`, async () => {
      const response = await request(app)
        .get('/api/me')
        .set('Cookie', `session=${users[role].sessionId}`)

      expect(response.status).toBe(200)
    })

    it(`allows ${role} to access /api/my-prs`, async () => {
      const response = await request(app)
        .get('/api/my-prs')
        .set('Cookie', `session=${users[role].sessionId}`)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('items')
    })

    it(`allows ${role} to access /api/repos`, async () => {
      const response = await request(app)
        .get('/api/repos')
        .set('Cookie', `session=${users[role].sessionId}`)

      expect(response.status).toBe(200)
    })
  }

  it('denies PR authors access to reviewer queue', async () => {
    const response = await request(app)
      .get('/api/queue')
      .set('Cookie', `session=${users.pr_author.sessionId}`)

    expect(response.status).toBe(403)
  })

  it('allows reviewers to access reviewer queue', async () => {
    const response = await request(app)
      .get('/api/queue')
      .set('Cookie', `session=${users.reviewer.sessionId}`)

    expect(response.status).toBe(200)
  })

  it('allows leads to access reviewer queue', async () => {
    const response = await request(app)
      .get('/api/queue')
      .set('Cookie', `session=${users.lead.sessionId}`)

    expect(response.status).toBe(200)
  })

  for (const role of ['pr_author', 'reviewer'] as const) {
    it(`denies ${role} repository creation`, async () => {
      const response = await request(app)
        .post('/api/repos')
        .set('Cookie', `session=${users[role].sessionId}`)
        .send({})

      expect(response.status).toBe(403)
    })
  }

  it('allows leads through repository creation authorization', async () => {
    const response = await request(app)
      .post('/api/repos')
      .set('Cookie', `session=${users.lead.sessionId}`)
      .send({})

    // A missing request body can fail validation, but not authorization.
    expect(response.status).not.toBe(401)
    expect(response.status).not.toBe(403)
  })

  for (const role of ['pr_author', 'reviewer', 'lead'] as const) {
    it(`returns 404 for an unknown PR as ${role}`, async () => {
      const response = await request(app)
        .get('/api/my-prs/999999')
        .set('Cookie', `session=${users[role].sessionId}`)

      expect(response.status).toBe(404)
    })
  }

  it('returns 403 with no PR fields when user has no repo access (US-01 AC3, NFR-02)', async () => {
    // Create a second repo in the same team that none of the test users have repo_access to
    const { rows: [{ team_id }] } = await pool.query<{ team_id: number }>(
      `SELECT team_id FROM repos WHERE github_repo_id = 99001`,
    )
    const { rows: [inaccessibleRepo] } = await pool.query<{ id: number }>(
      `INSERT INTO repos (team_id, github_repo_id, owner, name, webhook_secret_enc, status, sync_status)
       VALUES ($1, 99002, 'other-org', 'private-repo', 'test-secret', 'connected', 'ok')
       RETURNING id`,
      [team_id],
    )
    const { rows: [pr] } = await pool.query<{ id: number }>(
      `INSERT INTO pull_requests (repo_id, number, title, author_github_id, state, is_draft,
         lines_changed, last_activity_at, github_updated_at, behind_by, base_ref)
       VALUES ($1, 1, 'Private PR', 99099, 'open', false, 10, NOW(), NOW(), 0, 'main')
       RETURNING id`,
      [inaccessibleRepo.id],
    )

    const res = await request(app)
      .get(`/api/my-prs/${pr.id}`)
      .set('Cookie', `session=${users.reviewer.sessionId}`)

    expect(res.status).toBe(403)
    // Body must contain only the error field — no PR data leaked
    expect(res.body).toEqual({ error: "You don't have access to this repository" })
  })
})


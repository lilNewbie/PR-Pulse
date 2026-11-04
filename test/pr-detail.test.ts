
import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'

let prId: number
let authorizedSession: string
let unauthorizedSession: string

async function createUser(githubId: number, login: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (github_id, login, github_token_enc)
     VALUES ($1, $2, $3) RETURNING id`,
    [githubId, login, encrypt('test-token')],
  )
  return Number(rows[0].id)
}

async function createSession(userId: number, teamId: number) {
  await pool.query(
    `INSERT INTO members (team_id, user_id, role)
     VALUES ($1, $2, 'reviewer')`,
    [teamId, userId],
  )

  const sessionId = `pr-detail-test-${userId}`

  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [sessionId, userId],
  )

  return sessionId
}

describe('GET /api/my-prs/:id', () => {
  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        webhook_events, reviews, review_requests,
        pull_requests, repo_access, repos,
        sessions, members, users, teams
      RESTART IDENTITY CASCADE
    `)

    const { rows: teams } = await pool.query<{ id: number }>(
      `INSERT INTO teams (name)
       VALUES ('PR Detail Test Team')
       RETURNING id`,
    )

    const teamId = Number(teams[0].id)

    await createUser(1001, 'test_author')
    const reviewerId = await createUser(1002, 'test_reviewer')
    const outsiderId = await createUser(1003, 'test_outsider')

    authorizedSession = await createSession(reviewerId, teamId)
    unauthorizedSession = await createSession(outsiderId, teamId)

    const { rows: repos } = await pool.query<{ id: number }>(
      `INSERT INTO repos
        (team_id, github_repo_id, owner, name,
         webhook_secret_enc, status, sync_status)
       VALUES
        ($1, 5001, 'test-org', 'test-repo',
         'test-secret', 'connected', 'ok')
       RETURNING id`,
      [teamId],
    )

    const repoId = Number(repos[0].id)

    await pool.query(
      `INSERT INTO repo_access (user_id, repo_id)
       VALUES ($1, $2)`,
      [reviewerId, repoId],
    )

    const { rows: prs } = await pool.query<{ id: number }>(
      `INSERT INTO pull_requests
        (repo_id, number, title, author_github_id,
         state, is_draft, lines_changed,
         last_activity_at, github_updated_at,
         behind_by, base_ref)
       VALUES
        ($1, 42, 'Test PR', 1001,
         'open', false, 25,
         NOW(), NOW(), 0, 'main')
       RETURNING id`,
      [repoId],
    )

    prId = Number(prs[0].id)

    await pool.query(
      `INSERT INTO review_requests
        (pr_id, reviewer_github_id, requested_at)
       VALUES ($1, 1002, '2026-11-01T10:00:00Z')`,
      [prId],
    )

    // Approval must remain effective after a later comment.
    await pool.query(
      `INSERT INTO reviews
        (pr_id, reviewer_github_id, state, submitted_at)
       VALUES
        ($1, 1002, 'approved', '2026-11-01T11:00:00Z'),
        ($1, 1002, 'commented', '2026-11-02T11:00:00Z')`,
      [prId],
    )
  })

  it('returns camelCase PR details with flags', async () => {
    const res = await request(app)
      .get(`/api/my-prs/${prId}`)
      .set('Cookie', `session=${authorizedSession}`)

    expect(res.status).toBe(200)

    expect(res.body).toMatchObject({
      id: prId,
      repo: 'test-org/test-repo',
      number: 42,
      title: 'Test PR',
      url: 'https://github.com/test-org/test-repo/pull/42',
      authorLogin: 'test_author',
      state: 'open',
      isDraft: false,
      linesChanged: 25,
    })

    expect(res.body.flags).toEqual({
      stale: expect.any(Boolean),
      inactiveHours: expect.any(Number),
      conflict: expect.stringMatching(/^(yes|no|checking)$/),
      behindBy: expect.any(Number),
    })

    expect(res.body).not.toHaveProperty('author_github_id')
    expect(res.body).not.toHaveProperty('repo_id')
    expect(res.body).not.toHaveProperty('is_draft')
  })

  it('returns review requests and preserves approval after a comment', async () => {
    const res = await request(app)
      .get(`/api/my-prs/${prId}`)
      .set('Cookie', `session=${authorizedSession}`)

    expect(res.status).toBe(200)

    expect(res.body.reviewRequests).toEqual([
      {
        reviewerLogin: 'test_reviewer',
        requestedAt: '2026-11-01T10:00:00.000Z',
      },
    ])

    expect(res.body.reviews).toEqual([
      {
        reviewerLogin: 'test_reviewer',
        state: 'approved',
        submittedAt: '2026-11-01T11:00:00.000Z',
      },
    ])
  })

  it('returns 400 for an invalid PR ID', async () => {
    const res = await request(app)
      .get('/api/my-prs/invalid')
      .set('Cookie', `session=${authorizedSession}`)

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid PR ID' })
  })

  it('returns 401 without a session', async () => {
    const res = await request(app).get(`/api/my-prs/${prId}`)

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Not signed in' })
  })

  it('returns 403 when the user lacks repository access', async () => {
    const res = await request(app)
      .get(`/api/my-prs/${prId}`)
      .set('Cookie', `session=${unauthorizedSession}`)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: "You don't have access to this repository",
    })
  })

  it('returns 404 when the PR does not exist', async () => {
    const res = await request(app)
      .get('/api/my-prs/999999')
      .set('Cookie', `session=${authorizedSession}`)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'PR not found' })
  })
})


import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'

let sessionId: string
let expectedPrIds: number[]

describe('GET /api/my-prs filtering', () => {
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
       VALUES ('My PRs Filter Test Team')
       RETURNING id`,
    )
    const teamId = Number(teams[0].id)

    const { rows: users } = await pool.query<{ id: number }>(
      `INSERT INTO users (github_id, login, github_token_enc)
       VALUES (2001, 'my_author', $1)
       RETURNING id`,
      [encrypt('test-token')],
    )
    const userId = Number(users[0].id)

    await pool.query(
      `INSERT INTO members (team_id, user_id, role)
       VALUES ($1, $2, 'pr_author')`,
      [teamId, userId],
    )

    sessionId = `my-prs-filter-${userId}`

    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [sessionId, userId],
    )

    const { rows: repos } = await pool.query<{ id: number }>(
      `INSERT INTO repos
        (team_id, github_repo_id, owner, name,
         webhook_secret_enc, status, sync_status)
       VALUES
        ($1, 6001, 'test-org', 'filter-repo',
         'test-secret', 'connected', 'ok')
       RETURNING id`,
      [teamId],
    )
    const repoId = Number(repos[0].id)

    await pool.query(
      `INSERT INTO repo_access (user_id, repo_id)
       VALUES ($1, $2)`,
      [userId, repoId],
    )

    const fixtures = [
      { number: 1, author: 2001, state: 'open', draft: false },
      { number: 2, author: 2001, state: 'open', draft: true },
      { number: 3, author: 2001, state: 'closed', draft: false },
      { number: 4, author: 2001, state: 'merged', draft: false },
      { number: 5, author: 2002, state: 'open', draft: false },
    ]

    const ids: number[] = []

    for (const fixture of fixtures) {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO pull_requests
          (repo_id, number, title, author_github_id,
           state, is_draft, lines_changed,
           last_activity_at, github_updated_at,
           behind_by, base_ref)
         VALUES
          ($1, $2, $3, $4, $5, $6, 25,
           NOW(), NOW(), 0, 'main')
         RETURNING id`,
        [
          repoId,
          fixture.number,
          `Filter PR ${fixture.number}`,
          fixture.author,
          fixture.state,
          fixture.draft,
        ],
      )

      ids.push(Number(rows[0].id))
    }

    expectedPrIds = [ids[0], ids[1]]
  })

  it('returns only my open PRs, including drafts', async () => {
    const response = await request(app)
      .get('/api/my-prs')
      .set('Cookie', `session=${sessionId}`)

    expect(response.status).toBe(200)
    expect(Array.isArray(response.body.items)).toBe(true)

    const items = response.body.items as Array<{
      id: number
      number: number
      state: string
      isDraft: boolean
      authorLogin: string
    }>

    expect(items.map((pr) => pr.id).sort((a, b) => a - b))
      .toEqual([...expectedPrIds].sort((a, b) => a - b))

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: 1,
          state: 'open',
          isDraft: false,
          authorLogin: 'my_author',
        }),
        expect.objectContaining({
          number: 2,
          state: 'open',
          isDraft: true,
          authorLogin: 'my_author',
        }),
      ]),
    )

    expect(items).toHaveLength(2)
  })

  it('returns 401 without a session', async () => {
    const response = await request(app).get('/api/my-prs')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Not signed in' })
  })
})

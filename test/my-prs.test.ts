
import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'

let sessionId: string
let expectedPrIds: number[]

async function createUser(teamId: number, githubId: number, login: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (github_id, login, github_token_enc)
     VALUES ($1, $2, $3) RETURNING id`,
    [githubId, login, encrypt('test-token')],
  )

  const userId = Number(rows[0].id)

  await pool.query(
    `INSERT INTO members (team_id, user_id, role)
     VALUES ($1, $2, 'pr_author')`,
    [teamId, userId],
  )

  return userId
}

async function createRepo(
  teamId: number,
  githubRepoId: number,
  name: string,
) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO repos
      (team_id, github_repo_id, owner, name,
       webhook_secret_enc, status, sync_status)
     VALUES ($1, $2, 'test-org', $3,
             'test-secret', 'connected', 'ok')
     RETURNING id`,
    [teamId, githubRepoId, name],
  )

  return Number(rows[0].id)
}

async function createPr(
  repoId: number,
  number: number,
  authorGithubId: number,
  state: 'open' | 'closed' | 'merged',
  isDraft = false,
) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pull_requests
      (repo_id, number, title, author_github_id,
       state, is_draft, lines_changed,
       last_activity_at, github_updated_at,
       behind_by, base_ref)
     VALUES ($1, $2, $3, $4, $5, $6,
             10, NOW(), NOW(), 0, 'main')
     RETURNING id`,
    [
      repoId,
      number,
      `PR ${number}`,
      authorGithubId,
      state,
      isDraft,
    ],
  )

  return Number(rows[0].id)
}

describe('GET /api/my-prs', () => {
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
       VALUES ('My PRs Test Team')
       RETURNING id`,
    )

    const teamId = Number(teams[0].id)

    const meId = await createUser(teamId, 2001, 'me')
    await createUser(teamId, 2002, 'someone_else')

    const myRepo = await createRepo(
      teamId,
      7001,
      'visible',
    )

    const hiddenRepo = await createRepo(
      teamId,
      7002,
      'hidden',
    )

    await pool.query(
      `INSERT INTO repo_access
        (user_id, repo_id, checked_at)
       VALUES ($1, $2, NOW())`,
      [meId, myRepo],
    )

    const openPrId = await createPr(
      myRepo, 1, 2001, 'open',
    )

    const draftPrId = await createPr(
      myRepo, 2, 2001, 'open', true,
    )

    await createPr(myRepo, 3, 2001, 'merged')
    await createPr(myRepo, 4, 2001, 'closed')
    await createPr(myRepo, 5, 2002, 'open')
    await createPr(hiddenRepo, 6, 2001, 'open')

    expectedPrIds = [openPrId, draftPrId]

    sessionId = 'my-prs-test-session'

    await pool.query(
      `INSERT INTO sessions
        (id, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [sessionId, meId],
    )
  })

  it('US-08 AC1: returns only my open PRs, including drafts, from accessible repositories', async () => {
    const response = await request(app)
      .get('/api/my-prs')
      .set('Cookie', `session=${sessionId}`)

    expect(response.status).toBe(200)
    expect(Array.isArray(response.body.items)).toBe(true)

    const items = response.body.items as Array<{
      id: number
      number: number
      repo: string
      state: string
      isDraft: boolean
      authorLogin: string
    }>

    expect(items).toHaveLength(2)

    expect(
      items.map((pr) => pr.id).sort((a, b) => a - b),
    ).toEqual(
      [...expectedPrIds].sort((a, b) => a - b),
    )

    expect(
      items.map((pr) => pr.number).sort((a, b) => a - b),
    ).toEqual([1, 2])

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: 1,
          repo: 'test-org/visible',
          authorLogin: 'me',
          state: 'open',
          isDraft: false,
        }),
        expect.objectContaining({
          number: 2,
          repo: 'test-org/visible',
          authorLogin: 'me',
          state: 'open',
          isDraft: true,
        }),
      ]),
    )

    expect(items.every((pr) => pr.state === 'open')).toBe(true)

    expect(response.body.items[0]).toMatchObject({
      flags: expect.objectContaining({
        stale: false,
      }),
    })
  })

  it('returns 401 without a session', async () => {
    const response = await request(app)
      .get('/api/my-prs')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      error: 'Not signed in',
    })
  })
})

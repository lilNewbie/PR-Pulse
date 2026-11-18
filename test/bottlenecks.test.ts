import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'
import type { BottleneckResponse, Role } from 'shared'

const HOUR_MS = 60 * 60 * 1000
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS - 60_000)

interface Person {
  userId: number
  githubId: number
  login: string
  role: Role
  session: string
}

let teamId: number
let sandbox: number
let api: number
let hidden: number
let lead: Person
let reviewerA: Person
let reviewerB: Person
let reviewerZero: Person
let author: Person
let nextPrNumber: number

async function createPerson(githubId: number, login: string, role: Role): Promise<Person> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (github_id, login, github_token_enc)
     VALUES ($1, $2, $3) RETURNING id`,
    [githubId, login, encrypt('test-token')],
  )
  const userId = Number(rows[0].id)
  await pool.query(
    'INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, $3)',
    [teamId, userId, role],
  )
  const session = `bottleneck-${login}`
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [session, userId],
  )
  return { userId, githubId, login, role, session }
}

async function createRepo(githubRepoId: number, name: string, status = 'connected'): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO repos (team_id, github_repo_id, owner, name,
      webhook_secret_enc, status, sync_status)
     VALUES ($1, $2, 'test-org', $3, 'secret', $4, 'ok') RETURNING id`,
    [teamId, githubRepoId, name, status],
  )
  return Number(rows[0].id)
}

async function grantAccess(user: Person, repoId: number): Promise<void> {
  await pool.query(
    `INSERT INTO repo_access (user_id, repo_id, checked_at)
     VALUES ($1, $2, NOW())`,
    [user.userId, repoId],
  )
}

async function createPr(
  repoId: number,
  options: {
    title?: string
    inactiveHours?: number
    draft?: boolean
    state?: 'open' | 'closed' | 'merged'
    requestedReviewers?: Array<{ user: Person; waitHours: number }>
  } = {},
): Promise<number> {
  const number = nextPrNumber++
  const title = options.title ?? `Bottleneck PR ${number}`
  const activity = hoursAgo(options.inactiveHours ?? 1)
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO pull_requests
       (repo_id, number, title, author_github_id, state, is_draft,
        lines_changed, last_activity_at, github_updated_at,
        mergeable, behind_by, base_ref)
     VALUES ($1, $2, $3, $4, $5, $6, 12, $7, $7, true, 0, 'main')
     RETURNING id`,
    [repoId, number, title, author.githubId,
      options.state ?? 'open', options.draft ?? false, activity],
  )
  const id = Number(rows[0].id)
  for (const { user, waitHours } of options.requestedReviewers ?? []) {
    await pool.query(
      `INSERT INTO review_requests (pr_id, reviewer_github_id, requested_at)
       VALUES ($1, $2, $3)`,
      [id, user.githubId, hoursAgo(waitHours)],
    )
  }
  return id
}

async function getBottlenecks(session = lead.session, repoId?: number) {
  return request(app)
    .get('/api/team/bottlenecks')
    .query(repoId === undefined ? {} : { repoId })
    .set('Cookie', `session=${session}`)
}

beforeEach(async () => {
  await pool.query(`
    TRUNCATE TABLE webhook_events, reviews, review_requests,
      pull_requests, repo_access, repos, sessions, members, users, teams
    RESTART IDENTITY CASCADE
  `)
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO teams (name) VALUES ('Bottleneck Test Team') RETURNING id",
  )
  teamId = Number(rows[0].id)
  lead = await createPerson(60100, 'lead-dev', 'lead')
  reviewerA = await createPerson(60101, 'reviewer-a', 'reviewer')
  reviewerB = await createPerson(60102, 'reviewer-b', 'reviewer')
  reviewerZero = await createPerson(60103, 'reviewer-zero', 'reviewer')
  author = await createPerson(60104, 'author-dev', 'pr_author')
  sandbox = await createRepo(71101, 'sandbox')
  api = await createRepo(71102, 'api')
  hidden = await createRepo(71103, 'hidden')
  await grantAccess(lead, sandbox)
  await grantAccess(lead, api)
  nextPrNumber = 1
})

describe('US-18 GET /api/team/bottlenecks', () => {
  it('US-18 AC1: every reviewer and Lead appears; loads and oldest waits sorted highest first, zero included', async () => {
    for (const h of [2, 4, 7, 10, 50]) {
      await createPr(sandbox, { requestedReviewers: [{ user: reviewerA, waitHours: h }] })
    }
    for (const h of [3, 30, 8]) {
      await createPr(api, { requestedReviewers: [{ user: reviewerB, waitHours: h }] })
    }

    const res = await getBottlenecks()
    expect(res.status).toBe(200)
    const body = res.body as BottleneckResponse
    expect(body.reviewers.map((r) => [r.login, r.openRequests])).toEqual([
      ['reviewer-a', 5],
      ['reviewer-b', 3],
      ['lead-dev', 0],
      ['reviewer-zero', 0],
    ])
    expect(body.reviewers[0].oldestWaitHours).toBeGreaterThanOrEqual(50)
    expect(body.reviewers[1].oldestWaitHours).toBeGreaterThanOrEqual(30)
    expect(body.reviewers[2].oldestWaitHours).toBeNull()
    expect(body.reviewers[3].oldestWaitHours).toBeNull()
    expect(body.totals).toEqual({ openPrs: 8, openRequests: 8, stalePrs: 0 })
  })

  it('US-18 AC2: 4 open requests is overloaded; exactly 3 is not', async () => {
    for (let i = 0; i < 4; i++) {
      await createPr(sandbox, { requestedReviewers: [{ user: reviewerA, waitHours: i + 1 }] })
    }
    for (let i = 0; i < 3; i++) {
      await createPr(sandbox, { requestedReviewers: [{ user: reviewerB, waitHours: i + 1 }] })
    }
    const res = await getBottlenecks()
    expect(res.status).toBe(200)
    const body = res.body as BottleneckResponse
    expect(body.reviewers.find((r) => r.login === reviewerA.login)).toMatchObject({
      openRequests: 4,
      overloaded: true,
    })
    expect(body.reviewers.find((r) => r.login === reviewerB.login)).toMatchObject({
      openRequests: 3,
      overloaded: false,
    })
    expect(body.reviewers.find((r) => r.login === reviewerZero.login)).toMatchObject({
      openRequests: 0,
      overloaded: false,
    })
  })

  it('US-18 AC3: stale PRs across repos sorted by inactive hours; 23h59m is not stale', async () => {
    await createPr(sandbox, { title: 'Stale sandbox', inactiveHours: 30 })
    await createPr(api, { title: 'Oldest API PR', inactiveHours: 50 })
    await createPr(sandbox, { title: 'Under 24 hours', inactiveHours: 23 + 59 / 60 - 1 / 60 })

    const res = await getBottlenecks()
    expect(res.status).toBe(200)
    const body = res.body as BottleneckResponse
    expect(body.stalePrs.map((pr) => pr.title)).toEqual(['Oldest API PR', 'Stale sandbox'])
    expect(body.stalePrs.map((pr) => pr.inactiveHours)).toEqual([50, 30])
    expect(body.stalePrs[0]).toMatchObject({
      repo: 'test-org/api',
      url: expect.stringContaining('/pull/'),
      flags: expect.objectContaining({ stale: true }),
    })
    expect(body.totals).toEqual({ openPrs: 3, openRequests: 0, stalePrs: 2 })
  })

  it('US-18 AC4: repoId filters reviewer counts, totals and stale PRs to that repo', async () => {
    await createPr(sandbox, { inactiveHours: 30,
      requestedReviewers: [{ user: reviewerA, waitHours: 30 }] })
    await createPr(sandbox, { requestedReviewers: [{ user: reviewerB, waitHours: 2 }] })
    await createPr(api, { inactiveHours: 50,
      requestedReviewers: [{ user: reviewerA, waitHours: 50 }] })

    const all = await getBottlenecks()
    const onlySandbox = await getBottlenecks(lead.session, sandbox)
    const onlyApi = await getBottlenecks(lead.session, api)
    expect(all.status).toBe(200)
    expect(all.body.totals).toEqual({ openPrs: 3, openRequests: 3, stalePrs: 2 })
    expect(onlySandbox.body.totals).toEqual({ openPrs: 2, openRequests: 2, stalePrs: 1 })
    expect(onlyApi.body.totals).toEqual({ openPrs: 1, openRequests: 1, stalePrs: 1 })
    expect((onlySandbox.body as BottleneckResponse).stalePrs.map((pr) => pr.repo)).toEqual(['test-org/sandbox'])
    expect((onlyApi.body as BottleneckResponse).stalePrs.map((pr) => pr.repo)).toEqual(['test-org/api'])
    expect((onlySandbox.body as BottleneckResponse).reviewers.find((r) => r.login === reviewerA.login)?.openRequests).toBe(1)
  })

  it('US-18 AC5: no session 401; Reviewer/PR Author 403; Lead 200; inaccessible repo 403', async () => {
    expect((await request(app).get('/api/team/bottlenecks')).status).toBe(401)
    expect((await getBottlenecks(reviewerA.session)).status).toBe(403)
    expect((await getBottlenecks(author.session)).status).toBe(403)
    expect((await getBottlenecks(lead.session)).status).toBe(200)
    const denied = await getBottlenecks(lead.session, hidden)
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: "You don't have access to this repository" })
  })

  it('US-18 AC6: hidden repo PRs and review requests are excluded, even without repoId', async () => {
    await createPr(sandbox, { title: 'Visible', inactiveHours: 30,
      requestedReviewers: [{ user: reviewerA, waitHours: 30 }] })
    await createPr(hidden, { title: 'Not visible', inactiveHours: 80,
      requestedReviewers: [{ user: reviewerA, waitHours: 80 }] })

    const res = await getBottlenecks()
    expect(res.status).toBe(200)
    const body = res.body as BottleneckResponse
    expect(body.totals).toEqual({ openPrs: 1, openRequests: 1, stalePrs: 1 })
    expect(body.stalePrs.map((pr) => pr.title)).toEqual(['Visible'])
    expect(body.reviewers.find((r) => r.login === reviewerA.login)?.openRequests).toBe(1)
  })

  it('US-18 AC7: drafts, merged, closed and disconnected PRs are not counted', async () => {
    await createPr(sandbox, { title: 'Valid', requestedReviewers: [{ user: reviewerA, waitHours: 2 }] })
    await createPr(sandbox, { title: 'Draft', inactiveHours: 80, draft: true,
      requestedReviewers: [{ user: reviewerA, waitHours: 50 }] })
    await createPr(sandbox, { title: 'Merged', inactiveHours: 80, state: 'merged',
      requestedReviewers: [{ user: reviewerA, waitHours: 50 }] })
    await createPr(sandbox, { title: 'Closed', inactiveHours: 80, state: 'closed',
      requestedReviewers: [{ user: reviewerA, waitHours: 50 }] })
    const disconnected = await createRepo(71104, 'connecting', 'connecting')
    await grantAccess(lead, disconnected)
    await createPr(disconnected, { title: 'Not connected', inactiveHours: 80,
      requestedReviewers: [{ user: reviewerA, waitHours: 50 }] })

    const res = await getBottlenecks()
    expect(res.status).toBe(200)
    const body = res.body as BottleneckResponse
    expect(body.totals).toEqual({ openPrs: 1, openRequests: 1, stalePrs: 0 })
    expect(body.reviewers.find((r) => r.login === reviewerA.login)?.openRequests).toBe(1)
  })

  it('US-18: bad repoId is 400; empty accessible repo returns zero totals', async () => {
    for (const query of ['?repoId=', '?repoId=abc', '?repoId=-1', '?repoId=0']) {
      const res = await request(app)
        .get(`/api/team/bottlenecks${query}`)
        .set('Cookie', `session=${lead.session}`)
      expect(res.status).toBe(400)
    }
    const res = await getBottlenecks()
    expect(res.status).toBe(200)
    const body = res.body as BottleneckResponse
    expect(body.totals).toEqual({ openPrs: 0, openRequests: 0, stalePrs: 0 })
    expect(body.reviewers).toHaveLength(4)
    expect(body.stalePrs).toEqual([])
  })
})

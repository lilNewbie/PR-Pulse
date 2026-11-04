import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import nock from 'nock'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'
import { applyEvent, syncRepo } from '../server/src/sync'

const OWNER = 'pr-pulse-test'
const NAME = 'sandbox'
const REPO = `/repos/${OWNER}/${NAME}`
const AUTHOR = { id: 1001, login: 'author' }
const REVIEWER = { id: 2002, login: 'reviewer' }

let repoId: number

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

interface PullOpts {
  state?: 'open' | 'closed'
  merged?: boolean
  draft?: boolean
  updatedAt?: string
  mergeable?: boolean | null
  requested?: { id: number; login: string }[]
}

function pull(n: number, o: PullOpts = {}) {
  const updated = o.updatedAt ?? hoursAgo(1)
  return {
    number: n,
    title: `PR ${n}`,
    state: o.state ?? 'open',
    draft: o.draft ?? false,
    user: AUTHOR,
    created_at: hoursAgo(48),
    updated_at: updated,
    merged_at: o.merged ? updated : null,
    merge_commit_sha: o.merged ? `merge${n}` : null,
    mergeable: o.mergeable === undefined ? true : o.mergeable,
    additions: 10,
    deletions: 5,
    requested_reviewers: o.requested ?? [],
    base: { ref: 'main' },
    head: { sha: `sha${n}` },
  }
}

interface MockOpts {
  reviews?: object[]
  comments?: { created_at: string }[]
  commitDate?: string
  behindBy?: number
}

// Mocks every GitHub call fetchSnapshot makes for one PR.
function mockPr(p: ReturnType<typeof pull>, o: MockOpts = {}) {
  const api = nock('https://api.github.com')
  api.get(`${REPO}/pulls/${p.number}`).reply(200, p)
  api.get(`${REPO}/pulls/${p.number}/reviews`).query(true).reply(200, o.reviews ?? [])
  if (p.state === 'open') {
    api.get(`${REPO}/compare/main...${p.head.sha}`).reply(200, { behind_by: o.behindBy ?? 0 })
  }
  api.get(`${REPO}/commits/${p.head.sha}`).reply(200, { commit: { committer: { date: o.commitDate ?? hoursAgo(30) } } })
  api.get(`${REPO}/issues/${p.number}/comments`).query(true).reply(200, o.comments ?? [])
}

function mockList(pulls: object[]) {
  nock('https://api.github.com').get(`${REPO}/pulls`).query({ state: 'open', per_page: '100' }).reply(200, pulls)
}

async function insertPr(n: number, fields: Record<string, unknown> = {}): Promise<number> {
  const row = {
    title: `PR ${n}`,
    author_github_id: AUTHOR.id,
    state: 'open',
    last_activity_at: hoursAgo(30),
    github_updated_at: hoursAgo(30),
    base_ref: 'main',
    ...fields,
  }
  const cols = Object.keys(row)
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO pull_requests (repo_id, number, ${cols.join(', ')})
     VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
    [repoId, n, ...Object.values(row)],
  )
  return Number(rows[0].id)
}

async function prRow(n: number) {
  const { rows } = await pool.query('SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2', [repoId, n])
  return rows[0]
}

async function requests(prId: number) {
  const { rows } = await pool.query<{ reviewer_github_id: string; requested_at: Date }>(
    'SELECT reviewer_github_id, requested_at FROM review_requests WHERE pr_id = $1',
    [prId],
  )
  return rows
}

async function repoRow() {
  const { rows } = await pool.query('SELECT status, sync_status, retry_after, last_synced_at FROM repos WHERE id = $1', [
    repoId,
  ])
  return rows[0]
}

describe('PR Sync Service', () => {
  beforeEach(async () => {
    nock.disableNetConnect()
    nock.enableNetConnect(/127\.0\.0\.1|localhost/)
    await pool.query(
      'TRUNCATE TABLE webhook_events, reviews, review_requests, pull_requests, repos, members, users, teams RESTART IDENTITY CASCADE',
    )
    const {
      rows: [team],
    } = await pool.query<{ id: number }>("INSERT INTO teams (name) VALUES ('Team') RETURNING id")
    const {
      rows: [user],
    } = await pool.query<{ id: number }>(
      "INSERT INTO users (github_id, login, github_token_enc) VALUES (1001, 'author', $1) RETURNING id",
      [encrypt('gh-token')],
    )
    const {
      rows: [repo],
    } = await pool.query<{ id: string }>(
      `INSERT INTO repos (team_id, github_repo_id, owner, name, webhook_secret_enc, status, sync_status, connected_by)
       VALUES ($1, 900001, $2, $3, $4, 'connecting', 'ok', $5) RETURNING id`,
      [team.id, OWNER, NAME, encrypt('secret'), user.id],
    )
    repoId = Number(repo.id)
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  describe('applyEvent', () => {
    it('stores a new PR with every field from GitHub', async () => {
      mockPr(pull(7, { requested: [REVIEWER] }), { behindBy: 3 })
      await applyEvent(repoId, 7)
      const row = await prRow(7)
      expect(row).toMatchObject({ state: 'open', is_draft: false, lines_changed: 15, mergeable: true, behind_by: 3, base_ref: 'main' })
      expect((await requests(Number(row.id))).map((r) => Number(r.reviewer_github_id))).toEqual([REVIEWER.id])
      expect(nock.isDone()).toBe(true)
    })

    it('US-02 AC1: submitted review removes that reviewer\'s review request', async () => {
      const prId = await insertPr(7)
      await pool.query('INSERT INTO review_requests (pr_id, reviewer_github_id, requested_at) VALUES ($1, $2, $3)', [
        prId,
        REVIEWER.id,
        hoursAgo(5),
      ])
      mockPr(pull(7, { requested: [] }), {
        reviews: [{ id: 501, user: REVIEWER, state: 'APPROVED', submitted_at: hoursAgo(0.1) }],
      })
      await applyEvent(repoId, 7)
      expect(await requests(prId)).toEqual([])
      const { rows } = await pool.query('SELECT state, reviewer_github_id FROM reviews WHERE pr_id = $1', [prId])
      expect(rows).toEqual([{ state: 'approved', reviewer_github_id: String(REVIEWER.id) }])
    })

    it('US-02 AC2: re-requested review returns with a new requested_at', async () => {
      const prId = await insertPr(7)
      const before = new Date()
      mockPr(pull(7, { requested: [REVIEWER] }), {
        reviews: [{ id: 501, user: REVIEWER, state: 'CHANGES_REQUESTED', submitted_at: hoursAgo(2) }],
      })
      await applyEvent(repoId, 7)
      const [req] = await requests(prId)
      expect(Number(req.reviewer_github_id)).toBe(REVIEWER.id)
      expect(req.requested_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
    })

    it('US-08 AC2: a comment on a stale PR updates last_activity_at', async () => {
      await insertPr(7, { last_activity_at: hoursAgo(30) })
      const commentAt = hoursAgo(0.05)
      mockPr(pull(7, { updatedAt: commentAt }), { comments: [{ created_at: hoursAgo(40) }, { created_at: commentAt }] })
      await applyEvent(repoId, 7)
      expect((await prRow(7)).last_activity_at.toISOString()).toBe(new Date(commentAt).toISOString())
    })

    it('US-08 AC2: a new commit on a stale PR updates last_activity_at', async () => {
      await insertPr(7, { last_activity_at: hoursAgo(30) })
      const commitAt = hoursAgo(0.05)
      mockPr(pull(7, { updatedAt: commitAt }), { commitDate: commitAt })
      await applyEvent(repoId, 7)
      expect((await prRow(7)).last_activity_at.toISOString()).toBe(new Date(commitAt).toISOString())
    })

    it('US-09 AC1: re-applying after a push to main stores the new conflict and behind count', async () => {
      await insertPr(7, { mergeable: true, behind_by: 0, github_updated_at: hoursAgo(1) })
      mockPr(pull(7, { mergeable: false, updatedAt: hoursAgo(1) }), { behindBy: 2 })
      await applyEvent(repoId, 7)
      expect(await prRow(7)).toMatchObject({ mergeable: false, behind_by: 2 })
    })

    it('US-09 AC4: mergeable null from GitHub is stored as null (checking)', async () => {
      mockPr(pull(7, { mergeable: null }))
      await applyEvent(repoId, 7)
      expect((await prRow(7)).mergeable).toBeNull()
    })

    it('US-10: older GitHub updated_at arriving after a newer one keeps the newer data', async () => {
      await insertPr(7, { title: 'newer', github_updated_at: hoursAgo(1) })
      mockPr(pull(7, { updatedAt: hoursAgo(3) }))
      await applyEvent(repoId, 7)
      expect((await prRow(7)).title).toBe('newer')
    })

    it('GitHub error: nothing is written', async () => {
      await insertPr(7, { title: 'before' })
      nock('https://api.github.com').get(`${REPO}/pulls/7`).reply(502)
      await expect(applyEvent(repoId, 7)).rejects.toThrow('GitHub responded 502')
      expect((await prRow(7)).title).toBe('before')
    })
  })

  describe('syncRepo', () => {
    it('US-05: initial sync imports open PRs and marks the repo connected', async () => {
      const p1 = pull(1)
      const p2 = pull(2, { draft: true })
      mockList([p1, p2])
      mockPr(p1)
      mockPr(p2)
      const result = await syncRepo(repoId, 'initial')
      expect(result).toMatchObject({ status: 'ok', prsUpserted: 2, prsClosed: 0 })
      expect(result.lastSyncedAt).toBeInstanceOf(Date)
      expect(await repoRow()).toMatchObject({ status: 'connected', sync_status: 'ok', retry_after: null })
      expect((await prRow(2)).is_draft).toBe(true)
    })

    it('US-10 AC1, AC2: missed merge is stored as merged with no duplicate row', async () => {
      await insertPr(1, { state: 'open' })
      mockList([])
      mockPr(pull(1, { state: 'closed', merged: true }))
      const result = await syncRepo(repoId, 'scheduled')
      expect(result).toMatchObject({ status: 'ok', prsUpserted: 0, prsClosed: 1 })
      expect(await prRow(1)).toMatchObject({ state: 'merged', merge_commit_sha: 'merge1' })
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM pull_requests')
      expect(rows[0].n).toBe(1)
    })

    it('US-10 AC3: rate limit mid-sync changes no PR rows, then backs off until retry_after', async () => {
      await insertPr(1, { title: 'stored', state: 'open' })
      const reset = Math.floor(Date.now() / 1000) + 3600
      mockList([pull(1), pull(2)])
      mockPr(pull(1, { mergeable: false }))
      nock('https://api.github.com')
        .get(`${REPO}/pulls/2`)
        .reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })

      const result = await syncRepo(repoId, 'scheduled')
      expect(result.status).toBe('rate_limited')
      expect(await prRow(1)).toMatchObject({ title: 'stored', mergeable: null })
      expect(await prRow(2)).toBeUndefined()
      const repo = await repoRow()
      expect(repo.sync_status).toBe('rate_limited')
      expect(repo.retry_after.getTime()).toBe(reset * 1000)
      expect(repo.last_synced_at).toBeNull()

      nock.cleanAll() // any GitHub call now would fail the test
      expect((await syncRepo(repoId, 'scheduled')).status).toBe('skipped')
    })

    it('US-10: skips PRs updated on GitHub in the last 2 minutes', async () => {
      mockList([pull(1, { updatedAt: new Date(Date.now() - 30_000).toISOString() })])
      const result = await syncRepo(repoId, 'scheduled')
      expect(result).toMatchObject({ status: 'ok', prsUpserted: 0 })
      expect(await prRow(1)).toBeUndefined()
    })

    it('US-10: GitHub 5xx marks the sync failed and changes no PR rows', async () => {
      await insertPr(1, { title: 'stored' })
      nock('https://api.github.com').get(`${REPO}/pulls`).query(true).reply(503)
      const result = await syncRepo(repoId, 'scheduled')
      expect(result.status).toBe('failed')
      expect((await repoRow()).sync_status).toBe('failed')
      expect((await prRow(1)).title).toBe('stored')
    })

    it('follows pagination of the open PR list', async () => {
      const api = nock('https://api.github.com')
      api
        .get(`${REPO}/pulls`)
        .query({ state: 'open', per_page: '100' })
        .reply(200, [pull(1)], { link: '<https://api.github.com/repositories/900001/pulls?state=open&per_page=100&page=2>; rel="next"' })
      api.get('/repositories/900001/pulls').query({ state: 'open', per_page: '100', page: '2' }).reply(200, [pull(2)])
      mockPr(pull(1))
      mockPr(pull(2))
      expect(await syncRepo(repoId, 'scheduled')).toMatchObject({ status: 'ok', prsUpserted: 2 })
    })
  })
})

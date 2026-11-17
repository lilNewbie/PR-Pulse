import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import nock from 'nock'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'
import {
  applyEvent,
  backfillFileTouches,
  recordPushTouches,
  syncRepo,
  BACKFILL_MAX_COMMITS,
} from '../server/src/sync'
import { computeFlags } from '../server/src/flags'

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
  labels?: string[]
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
    labels: (o.labels ?? []).map((name) => ({ name })),
    base: { ref: 'main' },
    head: { sha: `sha${n}` },
  }
}

interface MockOpts {
  reviews?: object[]
  comments?: { created_at: string }[]
  commitDate?: string
  behindBy?: number
  files?: string[]
}

// Mocks every GitHub call fetchSnapshot makes for one PR.
function mockPr(p: ReturnType<typeof pull>, o: MockOpts = {}) {
  const api = nock('https://api.github.com')
  api.get(`${REPO}/pulls/${p.number}`).reply(200, p)
  api.get(`${REPO}/pulls/${p.number}/reviews`).query(true).reply(200, o.reviews ?? [])
  if (p.state === 'open') {
    api.get(`${REPO}/compare/main...${p.head.sha}`).reply(200, { behind_by: o.behindBy ?? 0 })
    api.get(`${REPO}/pulls/${p.number}/files`).query(true).reply(200, (o.files ?? []).map((filename) => ({ filename })))
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
      'TRUNCATE TABLE webhook_events, file_touches, pr_files, reviews, review_requests, pull_requests, repos, members, users, teams RESTART IDENTITY CASCADE',
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

    it('US-08 AC2: a comment on a stale PR updates last_activity_at and clears the stale flag', async () => {
      await insertPr(7, { last_activity_at: hoursAgo(30) })
      expect(computeFlags(await prRow(7), new Date()).stale).toBe(true)

      const commentAt = hoursAgo(0.05)
      mockPr(pull(7, { updatedAt: commentAt }), { comments: [{ created_at: hoursAgo(40) }, { created_at: commentAt }] })
      await applyEvent(repoId, 7)

      const row = await prRow(7)
      expect(row.last_activity_at.toISOString()).toBe(new Date(commentAt).toISOString())
      expect(computeFlags(row, new Date())).toMatchObject({ stale: false, inactiveHours: 0 })
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
      nock('https://api.github.com').get(`${REPO}/commits`).query(true).reply(200, []) // backfill: no history
      const result = await syncRepo(repoId, 'initial')
      expect(result).toMatchObject({ status: 'ok', prsUpserted: 2, prsClosed: 0 })
      expect(typeof result.lastSyncedAt).toBe('string')
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

  describe('US-04: release-blocker label', () => {
    it('label added then removed: is_release_blocker true, then false', async () => {
      mockPr(pull(7, { labels: ['bug', 'release-blocker'], updatedAt: hoursAgo(2) }))
      await applyEvent(repoId, 7)
      expect((await prRow(7)).is_release_blocker).toBe(true)

      mockPr(pull(7, { labels: ['bug'], updatedAt: hoursAgo(1) }))
      await applyEvent(repoId, 7)
      expect((await prRow(7)).is_release_blocker).toBe(false)
    })

    it('the scheduled sync sets it too', async () => {
      const p = pull(1, { labels: ['release-blocker'], updatedAt: hoursAgo(1) })
      mockList([p])
      mockPr(p)
      await syncRepo(repoId, 'scheduled')
      expect((await prRow(1)).is_release_blocker).toBe(true)
    })
  })

  describe('US-11: changed files (pr_files)', () => {
    async function files(n: number): Promise<string[]> {
      const { rows } = await pool.query<{ path: string }>(
        `SELECT f.path FROM pr_files f JOIN pull_requests p ON p.id = f.pr_id
         WHERE p.repo_id = $1 AND p.number = $2 ORDER BY f.path`,
        [repoId, n],
      )
      return rows.map((r) => r.path)
    }

    it('stores the files a PR changes, and replaces them after a new push', async () => {
      mockPr(pull(7, { updatedAt: hoursAgo(2) }), { files: ['src/a.ts', 'src/b.ts'] })
      await applyEvent(repoId, 7)
      expect(await files(7)).toEqual(['src/a.ts', 'src/b.ts'])

      mockPr(pull(7, { updatedAt: hoursAgo(1) }), { files: ['src/b.ts', 'src/c.ts'] })
      await applyEvent(repoId, 7)
      expect(await files(7)).toEqual(['src/b.ts', 'src/c.ts'])
    })

    it('follows every page of the file list, capped at GitHub\'s 3,000 files', async () => {
      const p = pull(7)
      const api = nock('https://api.github.com')
      api.get(`${REPO}/pulls/7`).reply(200, p)
      api.get(`${REPO}/pulls/7/reviews`).query(true).reply(200, [])
      api.get(`${REPO}/compare/main...sha7`).reply(200, { behind_by: 0 })
      api.get(`${REPO}/commits/sha7`).reply(200, { commit: { committer: { date: hoursAgo(30) } } })
      api.get(`${REPO}/issues/7/comments`).query(true).reply(200, [])
      // 31 pages of 100 are on offer; only the first 30 (3,000 files) are read.
      for (let page = 1; page <= 31; page++) {
        const link = `<https://api.github.com/repositories/900001/pulls/7/files?per_page=100&page=${page + 1}>; rel="next"`
        const body = Array.from({ length: 100 }, (_, i) => ({ filename: `f/${page}-${i}.ts` }))
        if (page === 1) api.get(`${REPO}/pulls/7/files`).query({ per_page: '100' }).reply(200, body, { link })
        else api.get('/repositories/900001/pulls/7/files').query({ per_page: '100', page: String(page) }).reply(200, body, { link })
      }
      await applyEvent(repoId, 7)
      const stored = await files(7)
      expect(stored).toHaveLength(3000)
      expect(stored).toContain('f/30-99.ts')
      expect(stored).not.toContain('f/31-0.ts')
      expect(api.pendingMocks()).toEqual([expect.stringContaining('/repositories/900001/pulls/7/files')]) // page 31 never requested
    })

    it('a closed PR keeps its stored files without fetching them', async () => {
      mockPr(pull(7, { updatedAt: hoursAgo(2) }), { files: ['src/a.ts'] })
      await applyEvent(repoId, 7)
      mockPr(pull(7, { state: 'closed', updatedAt: hoursAgo(1) })) // no files mock: a request would fail
      await applyEvent(repoId, 7)
      expect((await prRow(7)).state).toBe('closed')
      expect(await files(7)).toEqual(['src/a.ts'])
    })
  })

  describe('US-11, US-15: file touches', () => {
    async function touches() {
      const { rows } = await pool.query<{ path: string; author_login: string; commit_sha: string }>(
        'SELECT path, author_login, commit_sha FROM file_touches WHERE repo_id = $1 ORDER BY commit_sha, path',
        [repoId],
      )
      return rows
    }

    const commit = (id: string, username: string | undefined, added: string[], modified: string[], removed: string[] = []) => ({
      id,
      timestamp: hoursAgo(1),
      author: { name: 'Someone', email: 'someone@example.com', ...(username ? { username } : {}) },
      added,
      modified,
      removed,
    })
    const push = (ref: string, commits: object[]) => ({
      ref,
      repository: { id: 900001, default_branch: 'main' },
      commits,
    })

    it('a push to the default branch stores touches for added and modified files', async () => {
      const n = await recordPushTouches(
        repoId,
        push('refs/heads/main', [commit('c1', 'alice', ['src/new.ts'], ['src/old.ts'], ['src/gone.ts'])]),
      )
      expect(n).toBe(2)
      expect(await touches()).toEqual([
        { path: 'src/new.ts', author_login: 'alice', commit_sha: 'c1' },
        { path: 'src/old.ts', author_login: 'alice', commit_sha: 'c1' },
      ])
    })

    it('a bot commit, or one without a GitHub username, stores nothing', async () => {
      await recordPushTouches(
        repoId,
        push('refs/heads/main', [commit('c1', 'dependabot[bot]', ['package.json'], []), commit('c2', undefined, ['a.ts'], [])]),
      )
      expect(await touches()).toEqual([])
    })

    it('a push to another branch stores nothing', async () => {
      await recordPushTouches(repoId, push('refs/heads/feature', [commit('c1', 'alice', ['a.ts'], [])]))
      expect(await touches()).toEqual([])
    })

    it('the same push delivered twice stores each touch once', async () => {
      const p = push('refs/heads/main', [commit('c1', 'alice', ['a.ts'], [])])
      expect(await recordPushTouches(repoId, p)).toBe(1)
      expect(await recordPushTouches(repoId, p)).toBe(0)
      expect(await touches()).toHaveLength(1)
    })

    describe('backfillFileTouches', () => {
      const ghCommit = (i: number, login = 'alice') => ({
        sha: `s${i}`,
        author: { login },
        commit: { committer: { date: new Date(Date.now() - i * 60_000).toISOString() } },
      })

      // Lists `commits` in pages of 100, like GitHub, plus an extra page that must never be read.
      function mockCommitList(commits: object[], extraPage = false) {
        const api = nock('https://api.github.com')
        const pages = Math.ceil(commits.length / 100) + (extraPage ? 1 : 0)
        for (let page = 1; page <= pages; page++) {
          const body = commits.slice((page - 1) * 100, page * 100)
          const headers: Record<string, string> =
            page < pages ? { link: `<https://api.github.com/repositories/900001/commits?per_page=100&page=${page + 1}>; rel="next"` } : {}
          if (page === 1) api.get(`${REPO}/commits`).query((q) => !q.page && !q.until).reply(200, body, headers)
          else api.get('/repositories/900001/commits').query((q) => q.page === String(page)).reply(200, body.length ? body : [ghCommit(9999)], headers)
        }
        return api
      }

      const mockFiles = (times: number) =>
        nock('https://api.github.com')
          .get(/\/repos\/pr-pulse-test\/sandbox\/commits\/s\d+/)
          .times(times)
          .reply(200, (uri: string) => {
            const sha = uri.match(/commits\/(s\d+)/)![1]
            return { files: [{ filename: `${sha}.ts`, status: 'modified' }, { filename: 'gone.ts', status: 'removed' }] }
          })

      it('stops at 500 commits', async () => {
        const list = mockCommitList(Array.from({ length: 500 }, (_, i) => ghCommit(i)), true)
        mockFiles(500)
        const result = await backfillFileTouches(repoId)
        expect(result).toEqual({ commits: BACKFILL_MAX_COMMITS, files: 500 })
        expect(list.pendingMocks()).toHaveLength(1) // page 6 never requested
        expect(await touches()).toHaveLength(500)
      })

      it('skips bot commits and commits with no GitHub account, and stores only added or modified files', async () => {
        mockCommitList([ghCommit(1), ghCommit(2, 'renovate[bot]'), { ...ghCommit(3), author: null }])
        mockFiles(1)
        expect(await backfillFileTouches(repoId)).toEqual({ commits: 1, files: 1 })
        expect(await touches()).toEqual([{ path: 's1.ts', author_login: 'alice', commit_sha: 's1' }])
      })

      it('on a rate limit it keeps what it stored, sets retry_after, and the next run resumes without duplicates', async () => {
        const reset = Math.floor(Date.now() / 1000) + 3600
        mockCommitList([ghCommit(1), ghCommit(2), ghCommit(3)])
        mockFiles(2) // s1 and s2
        nock('https://api.github.com')
          .get(`${REPO}/commits/s3`)
          .query(true)
          .reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })

        expect(await backfillFileTouches(repoId)).toEqual({ commits: 2, files: 2 })
        expect((await repoRow()).retry_after.getTime()).toBe(reset * 1000)
        expect((await repoRow()).sync_status).toBe('ok') // PR data is fine; only the backfill is waiting

        // Before retry_after: no GitHub calls at all.
        nock.cleanAll()
        expect(await backfillFileTouches(repoId)).toEqual({ commits: 0, files: 0 })

        // After the reset: resumes from the oldest stored commit (s2), which GitHub lists again.
        await pool.query('UPDATE repos SET retry_after = now() - interval \'1 second\' WHERE id = $1', [repoId])
        nock('https://api.github.com')
          .get(`${REPO}/commits`)
          .query((q) => typeof q.until === 'string')
          .reply(200, [ghCommit(2), ghCommit(3)])
        mockFiles(2)
        expect(await backfillFileTouches(repoId)).toEqual({ commits: 2, files: 1 })
        expect((await touches()).map((t) => t.commit_sha)).toEqual(['s1', 's2', 's3'])
      })

      it('the initial sync runs the backfill', async () => {
        mockList([])
        mockCommitList([ghCommit(1)])
        mockFiles(1)
        expect((await syncRepo(repoId, 'initial')).status).toBe('ok')
        expect(await touches()).toEqual([{ path: 's1.ts', author_login: 'alice', commit_sha: 's1' }])
      })
    })
  })
})

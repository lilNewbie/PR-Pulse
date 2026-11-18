import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'
import { directoryOf } from '../server/src/db/suggestions'
import type { SuggestionItem } from 'shared'

// GitHub ids of the people in the team.
const ME = 3001 // reviewer
const ALICE = 3002 // reviewer
const AUTHOR = 3003 // pr_author, opens the PRs
const PA = 3005 // pr_author
const LEAD = 3006 // lead

let teamId: number
let repoId: number
let hiddenRepoId: number
const users = new Map<number, number>() // github id -> user id

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000)

async function createUser(githubId: number, login: string, role: string | null) {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (github_id, login, github_token_enc) VALUES ($1, $2, $3) RETURNING id',
    [githubId, login, encrypt('test-token')],
  )
  const userId = Number(rows[0].id)
  users.set(githubId, userId)
  if (role) await pool.query('INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, $3)', [teamId, userId, role])
  return userId
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

let prNumber = 0
async function createPr(files: string[], o: { author?: number; repo?: number; draft?: boolean; state?: string } = {}) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO pull_requests
       (repo_id, number, title, author_github_id, state, is_draft, lines_changed,
        last_activity_at, github_updated_at, behind_by, base_ref, mergeable)
     VALUES ($1, $2, $3, $4, $5, $6, 10, now(), now(), 0, 'main', true) RETURNING id`,
    [o.repo ?? repoId, ++prNumber, `PR ${prNumber}`, o.author ?? AUTHOR, o.state ?? 'open', o.draft ?? false],
  )
  const prId = Number(rows[0].id)
  for (const path of files) await pool.query('INSERT INTO pr_files (pr_id, path) VALUES ($1, $2)', [prId, path])
  return prId
}

let shaCounter = 0
async function touch(path: string, login: string, at: Date, repo = repoId) {
  await pool.query(
    'INSERT INTO file_touches (repo_id, path, author_login, commit_sha, committed_at) VALUES ($1, $2, $3, $4, $5)',
    [repo, path, login, `sha${++shaCounter}`, at],
  )
}

async function requestReview(prId: number, reviewerGithubId: number) {
  await pool.query('INSERT INTO review_requests (pr_id, reviewer_github_id, requested_at) VALUES ($1, $2, now())', [
    prId,
    reviewerGithubId,
  ])
}

async function sessionFor(githubId: number) {
  const id = `session-${githubId}`
  await pool.query(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day') ON CONFLICT (id) DO NOTHING",
    [id, users.get(githubId)],
  )
  return id
}

async function suggestionsFor(githubId: number): Promise<SuggestionItem[]> {
  const res = await request(app)
    .get('/api/suggestions')
    .set('Cookie', `session=${await sessionFor(githubId)}`)
  expect(res.status).toBe(200)
  return res.body
}

// A team of reviewers, PR Authors and a lead, with one repo everyone can see and one nobody can.
async function setupTeam() {
  await pool.query(`
    TRUNCATE TABLE webhook_events, file_touches, pr_files, reviews, review_requests,
      pull_requests, repo_access, repos, sessions, members, users, teams
    RESTART IDENTITY CASCADE
  `)
  users.clear()
  const { rows } = await pool.query<{ id: string }>("INSERT INTO teams (name) VALUES ('Suggestions Team') RETURNING id")
  teamId = Number(rows[0].id)
  await createUser(ME, 'me', 'reviewer')
  await createUser(ALICE, 'alice', 'reviewer')
  await createUser(AUTHOR, 'author', 'pr_author')
  await createUser(PA, 'pa-user', 'pr_author')
  await createUser(LEAD, 'lead', 'lead')
  repoId = await createRepo(8001, 'app')
  hiddenRepoId = await createRepo(8002, 'hidden')
  for (const id of [ME, ALICE, AUTHOR, PA, LEAD]) await grantAccess(id, repoId)
}

// Gives a reviewer n open review requests on PRs with no files (so those PRs are never suggested themselves).
async function giveLoad(githubId: number, n: number, o: { draft?: boolean; state?: string; repo?: number } = {}) {
  for (let i = 0; i < n; i++) await requestReview(await createPr([], o), githubId)
}

describe('US-11 GET /api/suggestions', () => {
  beforeEach(setupTeam)

  it('US-11 AC1: a PR that changes a file I last committed to is suggested, with that file and date', async () => {
    const prId = await createPr(['src/auth/session.ts'])
    const at = hoursAgo(5)
    await touch('src/auth/session.ts', 'alice', hoursAgo(50))
    await touch('src/auth/session.ts', 'me', at)

    const items = await suggestionsFor(ME)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: prId,
      repo: 'test-org/app',
      title: expect.stringMatching(/^PR /),
      authorLogin: 'author',
      reviewRequested: false,
      reasons: [{ path: 'src/auth/session.ts', lastCommitAt: at.toISOString() }],
    })
    expect(await suggestionsFor(ALICE)).toEqual([])
  })

  it('US-11 AC2: no history on its files: not suggested, but still in my ranked queue when review was requested', async () => {
    const prId = await createPr(['src/billing.ts'])
    await touch('src/billing.ts', 'alice', hoursAgo(3))
    await requestReview(prId, ME)

    expect(await suggestionsFor(ME)).toEqual([])
    const queue = await request(app).get('/api/queue').set('Cookie', `session=session-${ME}`)
    expect(queue.status).toBe(200)
    expect(queue.body.items.map((i: { id: number }) => i.id)).toEqual([prId])
  })

  it('US-11 AC3: I am never suggested for a PR I authored', async () => {
    await createPr(['src/a.ts'], { author: ME })
    await touch('src/a.ts', 'me', hoursAgo(1))
    expect(await suggestionsFor(ME)).toEqual([])
  })

  it('US-11 AC4: a more recent committer who is not a team member falls back to the most recent member', async () => {
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'contractor', hoursAgo(1)) // no PR Pulse account at all
    await createUser(3010, 'other-team', null) // signed in, but not in this team
    await touch('src/a.ts', 'other-team', hoursAgo(2))
    await touch('src/a.ts', 'me', hoursAgo(10))
    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([prId])
  })

  it('US-11 AC4: no team member ever changed the file: nobody is suggested', async () => {
    await createPr(['src/a.ts'])
    await touch('src/a.ts', 'contractor', hoursAgo(1))
    expect(await suggestionsFor(ME)).toEqual([])
    expect(await suggestionsFor(ALICE)).toEqual([])
    expect(await suggestionsFor(LEAD)).toEqual([])
  })

  it('US-11 AC5: the most recent committer has the PR Author role, so the next reviewer is suggested (DR-03)', async () => {
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'pa-user', hoursAgo(1))
    await touch('src/a.ts', 'me', hoursAgo(10))
    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([prId])
  })

  it('US-11 AC6: a bot as the most recent committer is skipped', async () => {
    // Even a bot that somehow has a reviewer membership is never suggested.
    await createUser(3020, 'helper[bot]', 'reviewer')
    await grantAccess(3020, repoId)
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'helper[bot]', hoursAgo(1))
    await touch('src/a.ts', 'me', hoursAgo(10))
    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([prId])
    expect(await suggestionsFor(3020)).toEqual([])
  })

  it('US-11 AC7: a PR Author gets 403; no session gets 401', async () => {
    const pa = await request(app).get('/api/suggestions').set('Cookie', `session=${await sessionFor(PA)}`)
    expect(pa.status).toBe(403)
    expect(pa.body).toEqual({ error: expect.any(String) })

    const anon = await request(app).get('/api/suggestions')
    expect(anon.status).toBe(401)
  })

  it('US-11 AC8: a PR in a repo I cannot access is never returned', async () => {
    await createPr(['src/a.ts'], { repo: hiddenRepoId })
    await touch('src/a.ts', 'me', hoursAgo(1), hiddenRepoId)
    expect(await suggestionsFor(ME)).toEqual([])
  })

  it('the PR author is skipped as a candidate, falling back to the next committer', async () => {
    await pool.query("UPDATE members SET role = 'reviewer' WHERE user_id = $1", [users.get(AUTHOR)])
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'author', hoursAgo(1))
    await touch('src/a.ts', 'me', hoursAgo(10))
    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([prId])
  })

  it('a more recent eligible committer wins the file, so I am not suggested for it', async () => {
    await createPr(['src/a.ts'])
    await touch('src/a.ts', 'me', hoursAgo(10))
    await touch('src/a.ts', 'lead', hoursAgo(2))
    expect(await suggestionsFor(ME)).toEqual([])
    expect(await suggestionsFor(LEAD)).toHaveLength(1)
  })

  it('drafts and closed PRs are never suggested', async () => {
    await createPr(['src/a.ts'], { draft: true })
    await createPr(['src/a.ts'], { state: 'merged' })
    await touch('src/a.ts', 'me', hoursAgo(1))
    expect(await suggestionsFor(ME)).toEqual([])
  })

  it('shows at most 3 reasons, newest first, and marks a requested review', async () => {
    const prId = await createPr(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    await requestReview(prId, ME)
    await touch('a.ts', 'me', hoursAgo(4))
    await touch('b.ts', 'me', hoursAgo(1))
    await touch('c.ts', 'me', hoursAgo(3))
    await touch('d.ts', 'me', hoursAgo(2))

    const [item] = await suggestionsFor(ME)
    expect(item.reviewRequested).toBe(true)
    expect(item.reasons.map((r) => r.path)).toEqual(['b.ts', 'd.ts', 'c.ts'])
  })

  it('matches GitHub logins without regard to case', async () => {
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'ME', hoursAgo(1))
    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([prId])
  })
})

describe('US-19 load-aware suggestions', () => {
  const BOB = 3007 // reviewer

  beforeEach(async () => {
    await setupTeam()
    await createUser(BOB, 'bob', 'reviewer')
    await grantAccess(BOB, repoId)
  })

  it('US-19 AC1: the more recent toucher has 5 open requests and the other has 0, so the one with 0 is suggested', async () => {
    const prId = await createPr(['src/auth/session.ts'])
    await touch('src/auth/session.ts', 'alice', hoursAgo(1))
    await touch('src/auth/session.ts', 'me', hoursAgo(10))
    await giveLoad(ALICE, 5)

    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([prId])
    expect(await suggestionsFor(ALICE)).toEqual([])
  })

  it('US-19 AC2: with equal load, the more recent toucher is suggested', async () => {
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'me', hoursAgo(1))
    await touch('src/a.ts', 'alice', hoursAgo(10))
    await giveLoad(ME, 2)
    await giveLoad(ALICE, 2)

    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([prId])
    expect(await suggestionsFor(ALICE)).toEqual([])
  })

  it('US-19 AC3: the reason includes the file, my last commit date and my open review count', async () => {
    await createPr(['src/a.ts'])
    const at = hoursAgo(3)
    await touch('src/a.ts', 'me', at)
    await giveLoad(ME, 2)
    // Requests on drafts and closed PRs are not open requests (design-extension 1).
    await giveLoad(ME, 1, { draft: true })
    await giveLoad(ME, 1, { state: 'closed' })

    const [item] = await suggestionsFor(ME)
    expect(item.reasons).toEqual([{ path: 'src/a.ts', lastCommitAt: at.toISOString(), openRequests: 2 }])
  })

  it('US-19 AC4: the only eligible toucher is suggested regardless of load', async () => {
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'alice', hoursAgo(1))
    await giveLoad(ALICE, 5)

    const items = await suggestionsFor(ALICE)
    expect(items.map((i) => i.id)).toEqual([prId])
    expect(items[0].reasons[0].openRequests).toBe(5)
  })

  it('US-19 AC5: a 4th-most-recent toucher with 0 open is not considered', async () => {
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'alice', hoursAgo(1))
    await touch('src/a.ts', 'lead', hoursAgo(2))
    await touch('src/a.ts', 'bob', hoursAgo(3))
    await touch('src/a.ts', 'me', hoursAgo(10))
    for (const id of [ALICE, LEAD, BOB]) await giveLoad(id, 1)

    expect(await suggestionsFor(ME)).toEqual([])
    expect((await suggestionsFor(ALICE)).map((i) => i.id)).toEqual([prId])
  })

  it('open-requests regression: a request on a PR in a repo that is still connecting is not counted', async () => {
    const connecting = await createRepo(8004, 'connecting')
    await pool.query("UPDATE repos SET status = 'connecting' WHERE id = $1", [connecting])
    await grantAccess(ME, connecting)
    await createPr(['src/a.ts'])
    await touch('src/a.ts', 'me', hoursAgo(1))
    await giveLoad(ME, 1)
    await giveLoad(ME, 2, { repo: connecting })

    const [item] = await suggestionsFor(ME)
    expect(item.reasons[0].openRequests).toBe(1)
  })

  it('open-requests regression: requests in a repo I cannot access are not counted, for me or a teammate', async () => {
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'alice', hoursAgo(1))
    await touch('src/a.ts', 'me', hoursAgo(10))
    // Alice is busy only in a repo I can't see, so from my view she has 0 and, being more recent, keeps the file.
    await giveLoad(ALICE, 3, { repo: hiddenRepoId })
    expect(await suggestionsFor(ME)).toEqual([])

    // And my own count leaves out my requests there.
    await touch('src/a.ts', 'me', hoursAgo(0.5))
    await giveLoad(ME, 2, { repo: hiddenRepoId })
    const [item] = await suggestionsFor(ME)
    expect(item.id).toBe(prId)
    expect(item.reasons[0].openRequests).toBe(0)
  })

  it('counts the 3 most recent distinct touchers, so repeat commits by one person take one place', async () => {
    const prId = await createPr(['src/a.ts'])
    await touch('src/a.ts', 'alice', hoursAgo(1))
    await touch('src/a.ts', 'alice', hoursAgo(2))
    await touch('src/a.ts', 'lead', hoursAgo(3))
    await touch('src/a.ts', 'me', hoursAgo(10))
    await giveLoad(ALICE, 1)
    await giveLoad(LEAD, 1)

    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([prId])
  })

  it('picks per file, so I can win one file of a PR while a teammate wins another', async () => {
    const prId = await createPr(['src/a.ts', 'src/b.ts'])
    await touch('src/a.ts', 'alice', hoursAgo(1))
    await touch('src/a.ts', 'me', hoursAgo(5))
    await touch('src/b.ts', 'alice', hoursAgo(1))
    await giveLoad(ALICE, 3)

    const [mine] = await suggestionsFor(ME)
    expect(mine.id).toBe(prId)
    expect(mine.reasons.map((r) => r.path)).toEqual(['src/a.ts'])
    const [hers] = await suggestionsFor(ALICE)
    expect(hers.reasons.map((r) => r.path)).toEqual(['src/b.ts'])
  })
})

describe('US-20 POST /api/suggestions/:prId/dismiss', () => {
  async function dismiss(githubId: number | null, prId: number | string, body: object) {
    const req = request(app).post(`/api/suggestions/${prId}/dismiss`)
    if (githubId !== null) req.set('Cookie', `session=${await sessionFor(githubId)}`)
    return req.send(body)
  }

  async function feedbackRows() {
    const { rows } = await pool.query<{ user_id: string; directory: string; dismissed_at: Date }>(
      'SELECT user_id, directory, dismissed_at FROM suggestion_feedback ORDER BY directory',
    )
    return rows
  }

  beforeEach(setupTeam)

  it('US-20 AC1: dismissing src/auth/session.ts stops suggestions from any src/auth file', async () => {
    const sessionPr = await createPr(['src/auth/session.ts'])
    await createPr(['src/auth/token.ts'])
    const billingPr = await createPr(['src/billing/invoice.ts'])
    for (const path of ['src/auth/session.ts', 'src/auth/token.ts', 'src/billing/invoice.ts']) {
      await touch(path, 'me', hoursAgo(2))
    }
    expect(await suggestionsFor(ME)).toHaveLength(3)

    const res = await dismiss(ME, sessionPr, { path: 'src/auth/session.ts' })
    expect(res.status).toBe(204)
    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([billingPr])
    expect(await feedbackRows()).toMatchObject([{ user_id: String(users.get(ME)), directory: 'src/auth' }])
  })

  it('US-20 AC1: a PR with another reason left stays, showing only that reason', async () => {
    const prId = await createPr(['src/auth/session.ts', 'src/api/routes.ts'])
    await touch('src/auth/session.ts', 'me', hoursAgo(1))
    await touch('src/api/routes.ts', 'me', hoursAgo(2))

    expect((await dismiss(ME, prId, { path: 'src/auth/session.ts' })).status).toBe(204)
    const [item] = await suggestionsFor(ME)
    expect(item.reasons.map((r) => r.path)).toEqual(['src/api/routes.ts'])
  })

  it('US-20 AC2: after my dismissal, the next eligible teammate is suggested for those files', async () => {
    const prId = await createPr(['src/auth/session.ts'])
    await touch('src/auth/session.ts', 'me', hoursAgo(1))
    await touch('src/auth/session.ts', 'alice', hoursAgo(10))
    expect(await suggestionsFor(ALICE)).toEqual([])

    await dismiss(ME, prId, { path: 'src/auth/session.ts' })
    expect(await suggestionsFor(ME)).toEqual([])
    expect((await suggestionsFor(ALICE)).map((i) => i.id)).toEqual([prId])
  })

  it('US-20 AC3: a dismissal 31 days old no longer hides src/auth; one 29 days old still does', async () => {
    const prId = await createPr(['src/auth/session.ts'])
    await touch('src/auth/session.ts', 'me', hoursAgo(1))
    await dismiss(ME, prId, { path: 'src/auth/session.ts' })

    await pool.query("UPDATE suggestion_feedback SET dismissed_at = now() - interval '29 days'")
    expect(await suggestionsFor(ME)).toEqual([])

    await pool.query("UPDATE suggestion_feedback SET dismissed_at = now() - interval '31 days'")
    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([prId])
  })

  it('US-20 AC4: a path not in the PR, or no path, is 400 and stores nothing; an unknown PR is 404', async () => {
    const prId = await createPr(['src/auth/session.ts'])

    const wrong = await dismiss(ME, prId, { path: 'src/other.ts' })
    expect(wrong.status).toBe(400)
    expect(wrong.body).toEqual({ error: expect.any(String) })
    expect((await dismiss(ME, prId, {})).status).toBe(400)
    expect((await dismiss(ME, prId, { path: '' })).status).toBe(400)

    expect((await dismiss(ME, 999999, { path: 'src/auth/session.ts' })).status).toBe(404)
    expect((await dismiss(ME, 'abc', { path: 'src/auth/session.ts' })).status).toBe(404)
    expect(await feedbackRows()).toEqual([])
  })

  it('US-20 AC5: PR Author gets 403, no session gets 401, a PR in a repo I cannot access gets 403', async () => {
    const prId = await createPr(['src/a.ts'])
    expect((await dismiss(PA, prId, { path: 'src/a.ts' })).status).toBe(403)
    expect((await dismiss(null, prId, { path: 'src/a.ts' })).status).toBe(401)

    const hiddenPr = await createPr(['src/a.ts'], { repo: hiddenRepoId })
    const hidden = await dismiss(ME, hiddenPr, { path: 'src/a.ts' })
    expect(hidden.status).toBe(403)
    // Same answer whether or not the path is in the PR, so a hidden PR's files aren't revealed.
    expect((await dismiss(ME, hiddenPr, { path: 'nope.ts' })).status).toBe(403)
    expect(await feedbackRows()).toEqual([])
  })

  it('US-20 AC6: dismissing twice keeps one row and refreshes dismissed_at', async () => {
    const prId = await createPr(['src/auth/session.ts', 'src/auth/token.ts'])
    await dismiss(ME, prId, { path: 'src/auth/session.ts' })
    await pool.query("UPDATE suggestion_feedback SET dismissed_at = now() - interval '10 days'")

    expect((await dismiss(ME, prId, { path: 'src/auth/token.ts' })).status).toBe(204)
    const rows = await feedbackRows()
    expect(rows).toHaveLength(1)
    expect(Date.now() - rows[0].dismissed_at.getTime()).toBeLessThan(60_000)
  })

  it('a dismissal is per repo and per user: other repos and teammates are unaffected', async () => {
    const otherRepo = await createRepo(8003, 'other')
    for (const id of [ME, ALICE]) await grantAccess(id, otherRepo)
    const prId = await createPr(['src/auth/session.ts'])
    const otherPr = await createPr(['src/auth/session.ts'], { repo: otherRepo })
    const alicePr = await createPr(['src/auth/token.ts'])
    await touch('src/auth/session.ts', 'me', hoursAgo(1))
    await touch('src/auth/session.ts', 'me', hoursAgo(1), otherRepo)
    await touch('src/auth/token.ts', 'alice', hoursAgo(1))

    await dismiss(ME, prId, { path: 'src/auth/session.ts' })
    expect((await suggestionsFor(ME)).map((i) => i.id)).toEqual([otherPr])
    expect((await suggestionsFor(ALICE)).map((i) => i.id)).toEqual([alicePr])
  })

  it('a top-level file dismisses the repo root, which hides other top-level files but not subdirectories', async () => {
    const prId = await createPr(['README.md', 'package.json', 'src/a.ts'])
    for (const path of ['README.md', 'package.json', 'src/a.ts']) await touch(path, 'me', hoursAgo(1))

    await dismiss(ME, prId, { path: 'README.md' })
    expect(await feedbackRows()).toMatchObject([{ directory: '/' }])
    const [item] = await suggestionsFor(ME)
    expect(item.reasons.map((r) => r.path)).toEqual(['src/a.ts'])
  })
})

describe('directoryOf', () => {
  it('matches design-extension section 1', () => {
    expect(directoryOf('src/auth/session.ts')).toBe('src/auth')
    expect(directoryOf('README.md')).toBe('/')
    expect(directoryOf('a/b/c/d.ts')).toBe('a/b/c')
  })
})

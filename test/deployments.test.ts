import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import nock from 'nock'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'
import { linkDeployment, recordDeploymentEvent } from '../server/src/modules/deployments'
import type { Role, DeploymentDetail } from 'shared'

const OWNER = 'org'
const NAME = 'repo'
const GITHUB_API = nock('https://api.github.com')

// ─── helpers ────────────────────────────────────────────────────────────────

type Session = { userId: number; sessionId: string }

async function setup(): Promise<{ repoId: number; sessions: Record<Role, Session> }> {
  const { rows: [team] } = await pool.query<{ id: number }>(
    "INSERT INTO teams (name) VALUES ('Deploy Team') RETURNING id",
  )
  const teamId = team.id

  async function makeUser(role: Role, githubId: number): Promise<Session> {
    const { rows: [user] } = await pool.query<{ id: number }>(
      'INSERT INTO users (github_id, login, github_token_enc) VALUES ($1, $2, $3) RETURNING id',
      [githubId, `us12_${role}`, encrypt('fake-gh-token')],
    )
    const userId = user.id
    await pool.query('INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, $3)', [teamId, userId, role])
    const sessionId = `us12-${role}-${userId}`
    await pool.query(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      [sessionId, userId],
    )
    return { userId, sessionId }
  }

  const lead = await makeUser('lead', 80001)
  const reviewer = await makeUser('reviewer', 80002)
  const pr_author = await makeUser('pr_author', 80003)

  const { rows: [repo] } = await pool.query<{ id: string }>(
    `INSERT INTO repos (team_id, github_repo_id, owner, name, webhook_secret_enc, status, sync_status, connected_by)
     VALUES ($1, 88001, $2, $3, $4, 'connected', 'ok', $5) RETURNING id`,
    [teamId, OWNER, NAME, encrypt('secret'), lead.userId],
  )
  const repoId = Number(repo.id)

  await pool.query(
    'INSERT INTO repo_access (user_id, repo_id, checked_at) VALUES ($1, $2, now())',
    [lead.userId, repoId],
  )
  await pool.query(
    'INSERT INTO repo_access (user_id, repo_id, checked_at) VALUES ($1, $2, now())',
    [reviewer.userId, repoId],
  )

  return { repoId, sessions: { lead, reviewer, pr_author } }
}

async function insertDeployment(
  repoId: number,
  sha: string,
  environment: 'staging' | 'production',
  status: 'pending' | 'success' | 'failed',
  createdAt: string,
): Promise<number> {
  const { rows: [row] } = await pool.query<{ id: string }>(
    `INSERT INTO deployments (repo_id, sha, environment, status, source, created_at)
     VALUES ($1, $2, $3, $4, 'webhook', $5) RETURNING id`,
    [repoId, sha, environment, status, createdAt],
  )
  return Number(row.id)
}

async function insertMergedPr(repoId: number, num: number, mergeCommitSha: string): Promise<number> {
  const { rows: [row] } = await pool.query<{ id: string }>(
    `INSERT INTO pull_requests
       (repo_id, number, title, author_github_id, state, is_draft, lines_changed,
        last_activity_at, github_updated_at, behind_by, base_ref, merge_commit_sha, merged_at)
     VALUES ($1, $2, $3, 90001, 'merged', false, 10, now(), now(), 0, 'main', $4, now())
     RETURNING id`,
    [repoId, num, `PR ${num}`, mergeCommitSha],
  )
  return Number(row.id)
}

function mockCompare(base: string, head: string, commits: string[], page2?: string[]) {
  const intercept = GITHUB_API
    .get(`/repos/${OWNER}/${NAME}/compare/${base}...${head}`)
  if (page2) {
    intercept.reply(
      200,
      { commits: commits.map((sha) => ({ sha })) },
      { link: `<https://api.github.com/repos/${OWNER}/${NAME}/compare/${base}...${head}?page=2>; rel="next"` },
    )
    GITHUB_API
      .get(`/repos/${OWNER}/${NAME}/compare/${base}...${head}`)
      .query({ page: '2' })
      .reply(200, { commits: page2.map((sha) => ({ sha })) })
  } else {
    intercept.reply(200, { commits: commits.map((sha) => ({ sha })) })
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('US-12 deployments', () => {
  let repoId: number
  let sessions: Record<Role, Session>

  beforeEach(async () => {
    nock.disableNetConnect()
    nock.enableNetConnect(/127\.0\.0\.1|localhost/)
    await pool.query(`
      TRUNCATE TABLE deployment_prs, deployments, file_touches, pr_files,
        reviews, review_requests, pull_requests, repo_access, repos,
        sessions, members, users, teams
      RESTART IDENTITY CASCADE
    `)
    ;({ repoId, sessions } = await setup())
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  it('US-12 AC1: PRs merged between prev and current success deploy are linked', async () => {
    const prevId = await insertDeployment(repoId, 'sha-prev', 'staging', 'success', '2026-11-10T10:00:00Z')
    const currId = await insertDeployment(repoId, 'sha-curr', 'staging', 'success', '2026-11-11T10:00:00Z')
    const prId1 = await insertMergedPr(repoId, 1, 'commit-aaa')
    await insertMergedPr(repoId, 2, 'commit-not-in-range') // different sha — should not be linked

    mockCompare('sha-prev', 'sha-curr', ['commit-aaa', 'commit-other'])

    const result = await linkDeployment(currId)
    expect(result.previousDeploymentId).toBe(prevId)
    expect(result.prCount).toBe(1)

    const res = await request(app)
      .get(`/api/deployments/${currId}`)
      .set('Cookie', `session=${sessions.lead.sessionId}`)
    expect(res.status).toBe(200)
    const body = res.body as DeploymentDetail
    expect(body.previousDeploymentId).toBe(prevId)
    expect(body.prs).toHaveLength(1)
    expect(body.prs[0].number).toBe(1)
    expect(body.prs[0]).toHaveProperty('title')
    expect(body.prs[0]).toHaveProperty('authorLogin')
    expect(body.prs[0].url).toContain('/pull/1')

    void prId1 // used implicitly via merge_commit_sha
  })

  it('US-12 AC2: failed deploy is labelled failed and PRs are still linked', async () => {
    await insertDeployment(repoId, 'sha-prev', 'staging', 'success', '2026-11-10T10:00:00Z')
    const currId = await insertDeployment(repoId, 'sha-curr', 'staging', 'failed', '2026-11-11T10:00:00Z')
    await insertMergedPr(repoId, 3, 'commit-bbb')

    mockCompare('sha-prev', 'sha-curr', ['commit-bbb'])

    await linkDeployment(currId)

    const res = await request(app)
      .get(`/api/deployments/${currId}`)
      .set('Cookie', `session=${sessions.lead.sessionId}`)
    expect(res.status).toBe(200)
    const body = res.body as DeploymentDetail
    expect(body.status).toBe('failed')
    expect(body.prs).toHaveLength(1)
  })

  it('US-12 AC3: deploy range with no matching merged PR → prs: []', async () => {
    await insertDeployment(repoId, 'sha-prev', 'staging', 'success', '2026-11-10T10:00:00Z')
    const currId = await insertDeployment(repoId, 'sha-curr', 'staging', 'success', '2026-11-11T10:00:00Z')

    mockCompare('sha-prev', 'sha-curr', ['commit-no-match'])

    const result = await linkDeployment(currId)
    expect(result.prCount).toBe(0)

    const res = await request(app)
      .get(`/api/deployments/${currId}`)
      .set('Cookie', `session=${sessions.lead.sessionId}`)
    expect(res.status).toBe(200)
    expect((res.body as DeploymentDetail).prs).toEqual([])
  })

  it('US-12 AC4: deployment event for a non-tracked environment writes nothing', async () => {
    const payload = {
      deployment: { id: 777, sha: 'sha-preview', environment: 'preview' },
      deployment_status: { state: 'success' },
    }
    const result = await recordDeploymentEvent(repoId, payload)
    expect(result).toBeNull()

    const { rows } = await pool.query('SELECT id FROM deployments WHERE repo_id = $1', [repoId])
    expect(rows).toHaveLength(0)
  })

  it('US-12 AC5: first deploy to an environment has no previous deploy and no linked PRs', async () => {
    // A staging deploy exists — should NOT count as previous for production
    await insertDeployment(repoId, 'sha-staging', 'staging', 'success', '2026-11-10T10:00:00Z')
    const currId = await insertDeployment(repoId, 'sha-prod', 'production', 'success', '2026-11-11T10:00:00Z')

    // No GitHub call expected — no previous prod deploy to compare with
    const result = await linkDeployment(currId)
    expect(result.previousDeploymentId).toBeNull()
    expect(result.prCount).toBe(0)

    const res = await request(app)
      .get(`/api/deployments/${currId}`)
      .set('Cookie', `session=${sessions.lead.sessionId}`)
    expect(res.status).toBe(200)
    expect((res.body as DeploymentDetail).previousDeploymentId).toBeNull()
    expect((res.body as DeploymentDetail).prs).toEqual([])
    expect(nock.isDone()).toBe(true) // no GitHub calls made
  })

  it('US-12 AC6: 401 without session; 403 for reviewer and pr_author; 403 for lead without repo access; 404 for unknown id', async () => {
    const depId = await insertDeployment(repoId, 'sha-x', 'staging', 'success', '2026-11-11T10:00:00Z')

    const noSession = await request(app).get(`/api/deployments/${depId}`)
    expect(noSession.status).toBe(401)

    const asReviewer = await request(app)
      .get(`/api/deployments/${depId}`)
      .set('Cookie', `session=${sessions.reviewer.sessionId}`)
    expect(asReviewer.status).toBe(403)

    const asAuthor = await request(app)
      .get(`/api/deployments/${depId}`)
      .set('Cookie', `session=${sessions.pr_author.sessionId}`)
    expect(asAuthor.status).toBe(403)

    // Lead with no repo access — create a second repo they can't see
    const { rows: [otherRepo] } = await pool.query<{ id: string }>(
      `INSERT INTO repos (team_id, github_repo_id, owner, name, webhook_secret_enc, status, sync_status, connected_by)
       VALUES ((SELECT team_id FROM repos WHERE id = $1), 88002, 'other', 'repo', $2, 'connected', 'ok', $3) RETURNING id`,
      [repoId, encrypt('secret2'), sessions.lead.userId],
    )
    const otherDepId = await insertDeployment(Number(otherRepo.id), 'sha-other', 'staging', 'success', '2026-11-11T10:00:00Z')
    const noAccess = await request(app)
      .get(`/api/deployments/${otherDepId}`)
      .set('Cookie', `session=${sessions.lead.sessionId}`)
    expect(noAccess.status).toBe(403)

    const notFound = await request(app)
      .get('/api/deployments/9999999')
      .set('Cookie', `session=${sessions.lead.sessionId}`)
    expect(notFound.status).toBe(404)
  })

  it('US-12 AC7: same deployment_status event delivered twice → one row, links unchanged', async () => {
    await insertDeployment(repoId, 'sha-prev', 'staging', 'success', '2026-11-10T10:00:00Z')
    await insertMergedPr(repoId, 5, 'commit-ccc')

    const payload = {
      deployment: { id: 999, sha: 'sha-new', environment: 'staging' },
      deployment_status: { state: 'success' },
    }

    // First delivery — GitHub compare succeeds
    mockCompare('sha-prev', 'sha-new', ['commit-ccc'])
    const id1 = await recordDeploymentEvent(repoId, payload)

    // Second delivery — same payload; nock has no interceptors left so GitHub won't be called again
    const id2 = await recordDeploymentEvent(repoId, payload)
    expect(id1).toBe(id2)

    const { rows } = await pool.query(
      'SELECT id FROM deployments WHERE repo_id = $1 AND sha = $2 AND environment = $3',
      [repoId, 'sha-new', 'staging'],
    )
    expect(rows).toHaveLength(1)

    // Links from first delivery are still intact
    const { rows: dpRows } = await pool.query(
      'SELECT pr_id FROM deployment_prs WHERE deployment_id = $1',
      [id1],
    )
    expect(dpRows).toHaveLength(1)
  })

  it('US-12 AC8: GitHub compare failure keeps the deployment row; a later linkDeployment call links it', async () => {
    await insertDeployment(repoId, 'sha-prev', 'staging', 'success', '2026-11-10T10:00:00Z')
    const currId = await insertDeployment(repoId, 'sha-curr', 'staging', 'success', '2026-11-11T10:00:00Z')
    await insertMergedPr(repoId, 6, 'commit-ddd')

    // First attempt — GitHub fails
    GITHUB_API
      .get(`/repos/${OWNER}/${NAME}/compare/sha-prev...sha-curr`)
      .reply(500)

    await expect(linkDeployment(currId)).rejects.toThrow()

    // Deployment row is still there
    const { rows: depRows } = await pool.query('SELECT id FROM deployments WHERE id = $1', [currId])
    expect(depRows).toHaveLength(1)

    // No deployment_prs written
    const { rows: dpRows } = await pool.query(
      'SELECT pr_id FROM deployment_prs WHERE deployment_id = $1',
      [currId],
    )
    expect(dpRows).toHaveLength(0)

    // Retry — GitHub succeeds this time
    mockCompare('sha-prev', 'sha-curr', ['commit-ddd'])
    const result = await linkDeployment(currId)
    expect(result.prCount).toBe(1)

    const { rows: dpRows2 } = await pool.query(
      'SELECT pr_id FROM deployment_prs WHERE deployment_id = $1',
      [currId],
    )
    expect(dpRows2).toHaveLength(1)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import pool from '../server/src/db/pool'
import app from '../server/src/app'
import { encrypt } from '../server/src/lib/crypto'
import { DeploymentHistoryResults } from '../client/src/pages/Deployments'
import type { Role } from 'shared'

type Session = { userId: number; cookie: string }

let visibleRepoId: number
let hiddenRepoId: number
let sessions: Record<Role, Session>

async function makeUser(teamId: number, role: Role, githubId: number): Promise<Session> {
  const { rows: [user] } = await pool.query<{ id: string }>(
    'INSERT INTO users (github_id, login, github_token_enc) VALUES ($1, $2, $3) RETURNING id',
    [githubId, `us13_${role}`, encrypt('test-token')],
  )
  const userId = Number(user.id)
  await pool.query('INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, $3)',
    [teamId, userId, role])
  const cookie = `us13-${role}-${userId}`
  await pool.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
    [cookie, userId])
  return { userId, cookie }
}

async function makeRepo(teamId: number, githubId: number, name: string): Promise<number> {
  const { rows: [repo] } = await pool.query<{ id: string }>(
    `INSERT INTO repos (team_id, github_repo_id, owner, name, webhook_secret_enc, status, sync_status)
     VALUES ($1, $2, 'us13-org', $3, 'secret', 'connected', 'ok') RETURNING id`,
    [teamId, githubId, name],
  )
  return Number(repo.id)
}

async function makeDeployment(
  repoId: number,
  sha: string,
  environment: 'staging' | 'production',
  status: 'pending' | 'success' | 'failed',
  createdAt: string,
): Promise<number> {
  const { rows: [deployment] } = await pool.query<{ id: string }>(
    `INSERT INTO deployments (repo_id, sha, environment, status, source, created_at)
     VALUES ($1, $2, $3, $4, 'webhook', $5) RETURNING id`,
    [repoId, sha, environment, status, createdAt],
  )
  return Number(deployment.id)
}

async function makeLinkedPr(deploymentId: number, number: number) {
  const { rows: [pr] } = await pool.query<{ id: string }>(
    `INSERT INTO pull_requests
       (repo_id, number, title, author_github_id, state, is_draft,
        lines_changed, last_activity_at, github_updated_at, behind_by, base_ref)
     VALUES ($1, $2, $3, 90123, 'merged', false, 10, now(), now(), 0, 'main')
     RETURNING id`,
    [visibleRepoId, number, `PR ${number}`],
  )
  await pool.query('INSERT INTO deployment_prs (deployment_id, pr_id) VALUES ($1, $2)',
    [deploymentId, pr.id])
}

function getHistory(query: string, role: Role = 'lead') {
  return request(app)
    .get(`/api/deployments?${query}`)
    .set('Cookie', `session=${sessions[role].cookie}`)
}

describe('US-13 deployment history', () => {
  beforeEach(async () => {
    await pool.query(`
      TRUNCATE TABLE
        deployment_prs, deployments, file_touches, pr_files, webhook_events,
        reviews, review_requests, pull_requests, repo_access, repos,
        sessions, members, users, teams
      RESTART IDENTITY CASCADE
    `)

    const { rows: [team] } = await pool.query<{ id: string }>(
      "INSERT INTO teams (name) VALUES ('Deployment History Test') RETURNING id",
    )
    const teamId = Number(team.id)
    sessions = {
      lead: await makeUser(teamId, 'lead', 77001),
      reviewer: await makeUser(teamId, 'reviewer', 77002),
      pr_author: await makeUser(teamId, 'pr_author', 77003),
    }
    visibleRepoId = await makeRepo(teamId, 77901, 'visible')
    hiddenRepoId = await makeRepo(teamId, 77902, 'hidden')
    for (const role of ['lead', 'reviewer', 'pr_author'] as const) {
      await pool.query('INSERT INTO repo_access (user_id, repo_id, checked_at) VALUES ($1, $2, now())',
        [sessions[role].userId, visibleRepoId])
    }
  })

  it('US-13 AC1: newest first, environment, ISO date, status, source, and distinct PR counts', async () => {
    const older = await makeDeployment(visibleRepoId, 'oldsha', 'production', 'success', '2026-11-01T10:00:00.000Z')
    const newer = await makeDeployment(visibleRepoId, 'newsha', 'staging', 'failed', '2026-11-02T10:00:00.000Z')
    await makeLinkedPr(newer, 1)
    await makeLinkedPr(newer, 2)
    // An unlinked deploy in another repo must never appear.
    await makeDeployment(hiddenRepoId, 'private-sha', 'staging', 'success', '2026-11-03T10:00:00.000Z')

    const response = await getHistory(`repoId=${visibleRepoId}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual([
      {
        id: newer, sha: 'newsha', environment: 'staging', status: 'failed',
        source: 'webhook', createdAt: '2026-11-02T10:00:00.000Z', prCount: 2,
      },
      {
        id: older, sha: 'oldsha', environment: 'production', status: 'success',
        source: 'webhook', createdAt: '2026-11-01T10:00:00.000Z', prCount: 0,
      },
    ])
  })

  it('US-13 AC2: environment=production excludes staging deployments', async () => {
    await makeDeployment(visibleRepoId, 'stage', 'staging', 'success', '2026-11-02T10:00:00.000Z')
    const productionId = await makeDeployment(visibleRepoId, 'prod', 'production', 'pending', '2026-11-01T10:00:00.000Z')
    const response = await getHistory(`repoId=${visibleRepoId}&environment=production`)
    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(1)
    expect(response.body[0]).toMatchObject({ id: productionId, environment: 'production' })
  })

  it('US-13 AC3: no deployments returns [] and the page renders the specified empty state', async () => {
    const response = await getHistory(`repoId=${visibleRepoId}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual([])
    const html = renderToStaticMarkup(createElement(DeploymentHistoryResults, { items: [] }))
    expect(html).toContain('No deployments recorded for this repository')
  })

  it('US-13 AC4: no session gets 401', async () => {
    const response = await request(app).get(`/api/deployments?repoId=${visibleRepoId}`)
    expect(response.status).toBe(401)
  })

  it('US-13 AC4: reviewer and PR Author each get 403, even with repo access', async () => {
    for (const role of ['reviewer', 'pr_author'] as const) {
      const response = await getHistory(`repoId=${visibleRepoId}`, role)
      expect(response.status).toBe(403)
      expect(response.body).toHaveProperty('error')
    }
  })

  it('US-13 AC4: Lead without repo_access gets 403 without deployment fields', async () => {
    await makeDeployment(hiddenRepoId, 'secretsha', 'production', 'success', '2026-11-01T10:00:00.000Z')
    const response = await getHistory(`repoId=${hiddenRepoId}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: "You don't have access to this repository" })
  })

  it('US-13 AC5: missing repoId or invalid environment returns 400', async () => {
    const missing = await getHistory('environment=staging')
    const invalidEnv = await getHistory(`repoId=${visibleRepoId}&environment=preview`)
    expect(missing.status).toBe(400)
    expect(invalidEnv.status).toBe(400)
  })

  it('US-13 AC5: malformed, repeated, zero, and unsafe repoId values return 400', async () => {
    for (const query of [
      'repoId=abc', 'repoId=0', 'repoId=-1', 'repoId=9007199254740993',
      `repoId=${visibleRepoId}&repoId=${hiddenRepoId}`,
    ]) {
      const response = await getHistory(query)
      expect(response.status).toBe(400)
    }
  })
})

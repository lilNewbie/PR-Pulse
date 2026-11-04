import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'
import { rankQueue } from '../server/src/modules/queue/rank'
import type { QueueRow } from '../server/src/db/types'
import type { Role } from 'shared'

vi.mock('../server/src/db/prs', () => ({
  listQueueRows: vi.fn(),
}))

import * as prsDb from '../server/src/db/prs'

const NOW = new Date('2026-01-01T12:00:00Z')
const ME = { id: 1, githubId: 11111, login: 'alan', role: 'reviewer' as Role }

function h(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
}

function makeRow(overrides: Partial<QueueRow> & { id: number }): QueueRow {
  return {
    repo_id: 1,
    repo_full_name: 'org/repo',
    number: overrides.id,
    title: `PR #${overrides.id}`,
    author_github_id: 99999,
    state: 'open',
    is_draft: false,
    ready_at: null,
    lines_changed: 100,
    last_activity_at: NOW,
    github_updated_at: NOW,
    mergeable: null,
    behind_by: 0,
    base_ref: 'main',
    merge_commit_sha: null,
    merged_at: null,
    requested_at: h(5),
    sync_status: 'ok',
    last_synced_at: null,
    ...overrides,
  }
}

async function cleanTables() {
  await pool.query(
    'TRUNCATE TABLE repo_access, sessions, members, users, teams RESTART IDENTITY CASCADE',
  )
}

async function createUserWithSession(opts: { role?: Role; githubId?: number } = {}) {
  const { role = 'reviewer', githubId = 22222 } = opts
  const tokenEnc = encrypt('fake-gh-token')
  const {
    rows: [team],
  } = await pool.query<{ id: number }>('INSERT INTO teams (name) VALUES ($1) RETURNING id', [
    'Test Team',
  ])
  const {
    rows: [user],
  } = await pool.query<{ id: number }>(
    'INSERT INTO users (github_id, login, github_token_enc) VALUES ($1, $2, $3) RETURNING id',
    [githubId, 'testuser', tokenEnc],
  )
  await pool.query('INSERT INTO members (team_id, user_id, role) VALUES ($1, $2, $3)', [
    team.id,
    user.id,
    role,
  ])
  const sessionId = 'test-session-' + Math.random().toString(36).slice(2)
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [
    sessionId,
    user.id,
    expiresAt,
  ])
  return { userId: user.id, sessionId, githubId }
}

describe('US-07 rankQueue', () => {
  it('US-07 AC1: PRs waiting 5h, 30h, 2h are listed 30h, 5h, 2h', () => {
    const rows = [
      makeRow({ id: 1, requested_at: h(5) }),
      makeRow({ id: 2, requested_at: h(30) }),
      makeRow({ id: 3, requested_at: h(2) }),
    ]
    const items = rankQueue(rows, ME, NOW)
    expect(items.map((i) => i.id)).toEqual([2, 1, 3])
    expect(items.map((i) => i.position)).toEqual([1, 2, 3])
    expect(items[0].waitingHours).toBe(30)
    expect(items[1].waitingHours).toBe(5)
    expect(items[2].waitingHours).toBe(2)
  })

  it('US-07 AC2: equal wait — fewer lines first', () => {
    const rows = [
      makeRow({ id: 1, requested_at: h(10), lines_changed: 300 }),
      makeRow({ id: 2, requested_at: h(10), lines_changed: 100 }),
    ]
    const items = rankQueue(rows, ME, NOW)
    expect(items[0].id).toBe(2)
    expect(items[1].id).toBe(1)
  })

  it('US-07 AC3: own PR not in queue; draft PRs not in queue', () => {
    const rows = [
      makeRow({ id: 1, author_github_id: ME.githubId }),
      makeRow({ id: 2, is_draft: true }),
      makeRow({ id: 3 }),
    ]
    const items = rankQueue(rows, ME, NOW)
    expect(items.length).toBe(1)
    expect(items[0].id).toBe(3)
  })

  it('US-07 AC6: re-requested review — wait time counts from new requested_at', () => {
    const rows = [
      makeRow({ id: 1, requested_at: h(10) }),
      makeRow({ id: 2, requested_at: h(2) }),
    ]
    const items = rankQueue(rows, ME, NOW)
    expect(items[0].id).toBe(1)
    expect(items[1].id).toBe(2)
    expect(items[1].waitingHours).toBe(2)
  })
})

describe('US-07 GET /api/queue', () => {
  beforeEach(async () => {
    await cleanTables()
    vi.mocked(prsDb.listQueueRows).mockResolvedValue([])
  })

  it('US-07: 401 without session', async () => {
    const res = await request(app).get('/api/queue')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Not signed in' })
  })

  it('US-07 AC5: 403 for pr_author', async () => {
    const { sessionId } = await createUserWithSession({ role: 'pr_author' })
    const res = await request(app).get('/api/queue').set('Cookie', `session=${sessionId}`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Requires reviewer' })
  })

  it('US-07 AC4: empty queue returns items: []', async () => {
    const { sessionId } = await createUserWithSession()
    const res = await request(app).get('/api/queue').set('Cookie', `session=${sessionId}`)
    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([])
    expect(res.body.syncWarning).toBe(false)
    expect(res.body.lastSyncedAt).toBeNull()
  })

  it('US-07 AC7: syncWarning:true and lastSyncedAt set when sync_status != ok', async () => {
    const { sessionId } = await createUserWithSession()
    const syncedAt = new Date('2026-01-01T10:00:00Z')
    vi.mocked(prsDb.listQueueRows).mockResolvedValue([
      makeRow({ id: 1, sync_status: 'rate_limited', last_synced_at: syncedAt }),
    ])
    const res = await request(app).get('/api/queue').set('Cookie', `session=${sessionId}`)
    expect(res.status).toBe(200)
    expect(res.body.syncWarning).toBe(true)
    expect(res.body.lastSyncedAt).toBe(syncedAt.toISOString())
  })
})

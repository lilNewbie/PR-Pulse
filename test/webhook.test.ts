import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import { createHmac } from 'crypto'
import app from '../server/src/app'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'

vi.mock('../server/src/sync', () => ({
  applyEvent: vi.fn(),
  syncRepo: vi.fn(),
}))

import { applyEvent } from '../server/src/sync'

const SECRET = 'test-webhook-secret'
const GITHUB_REPO_ID = 900001
const repository = { id: GITHUB_REPO_ID, full_name: 'pr-pulse-test/sandbox' }

let repoId: number
let deliveryCounter = 0

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

function send(
  event: string,
  payload: object,
  opts: { signature?: string | null; delivery?: string | null } = {},
) {
  const body = JSON.stringify(payload)
  const req = request(app)
    .post('/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', event)
  const delivery = opts.delivery === undefined ? `delivery-${++deliveryCounter}` : opts.delivery
  if (delivery !== null) req.set('X-GitHub-Delivery', delivery)
  const signature = opts.signature === undefined ? sign(body) : opts.signature
  if (signature !== null) req.set('X-Hub-Signature-256', signature)
  return req.send(body)
}

async function deliveryCount(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM webhook_events')
  return Number(rows[0].n)
}

async function insertPr(number: number, baseRef: string, state: 'open' | 'closed' | 'merged' = 'open') {
  await pool.query(
    `INSERT INTO pull_requests
       (repo_id, number, title, author_github_id, state, last_activity_at, github_updated_at, base_ref)
     VALUES ($1, $2, $3, 1001, $4, now(), now(), $5)`,
    [repoId, number, `PR ${number}`, state, baseRef],
  )
}

const prPayload = (action: string, number = 7) => ({ action, number, pull_request: { number }, repository })

describe('US-02 Webhook Receiver', () => {
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE webhook_events, pull_requests, repos, members, users, teams RESTART IDENTITY CASCADE',
    )
    const {
      rows: [team],
    } = await pool.query<{ id: number }>("INSERT INTO teams (name) VALUES ('Team') RETURNING id")
    const {
      rows: [user],
    } = await pool.query<{ id: number }>(
      "INSERT INTO users (github_id, login, github_token_enc) VALUES (1001, 'lead', $1) RETURNING id",
      [encrypt('fake-gh-token')],
    )
    const {
      rows: [repo],
    } = await pool.query<{ id: string }>(
      `INSERT INTO repos (team_id, github_repo_id, owner, name, webhook_secret_enc, status, sync_status, connected_by)
       VALUES ($1, $2, 'pr-pulse-test', 'sandbox', $3, 'connected', 'ok', $4) RETURNING id`,
      [team.id, GITHUB_REPO_ID, encrypt(SECRET), user.id],
    )
    repoId = Number(repo.id)
    vi.mocked(applyEvent).mockReset()
    vi.mocked(applyEvent).mockResolvedValue(undefined)
  })

  it('NFR-03: bad signature returns 401 and writes nothing', async () => {
    const res = await send('pull_request', prPayload('opened'), { signature: sign('tampered') })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Bad or missing signature' })
    expect(await deliveryCount()).toBe(0)
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('NFR-03: signature made with another secret returns 401 and writes nothing', async () => {
    const payload = prPayload('opened')
    const res = await send('pull_request', payload, { signature: sign(JSON.stringify(payload), 'wrong-secret') })
    expect(res.status).toBe(401)
    expect(await deliveryCount()).toBe(0)
  })

  it('NFR-03: missing signature returns 401 and writes nothing', async () => {
    const res = await send('pull_request', prPayload('opened'), { signature: null })
    expect(res.status).toBe(401)
    expect(await deliveryCount()).toBe(0)
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('NFR-06: same delivery ID twice, second returns 200 and changes nothing', async () => {
    const first = await send('pull_request', prPayload('opened'), { delivery: 'dup-1' })
    expect(first.status).toBe(202)
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))

    const second = await send('pull_request', prPayload('opened'), { delivery: 'dup-1' })
    expect(second.status).toBe(200)
    expect(await deliveryCount()).toBe(1)
    await new Promise((r) => setTimeout(r, 50))
    expect(applyEvent).toHaveBeenCalledTimes(1)
  })

  it('US-03: repo not connected returns 200 and writes nothing', async () => {
    const res = await send('pull_request', { ...prPayload('opened'), repository: { id: 424242 } })
    expect(res.status).toBe(200)
    expect(await deliveryCount()).toBe(0)
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('US-03: body without a repository returns 200 and writes nothing', async () => {
    const res = await send('ping', { zen: 'hello' })
    expect(res.status).toBe(200)
    expect(await deliveryCount()).toBe(0)
  })

  it('US-02: signed pull_request event returns 202, records the delivery and applies the PR', async () => {
    const res = await send('pull_request', prPayload('review_requested', 7), { delivery: 'd-pr' })
    expect(res.status).toBe(202)
    const { rows } = await pool.query('SELECT delivery_id, repo_id, event_type FROM webhook_events')
    expect(rows).toEqual([{ delivery_id: 'd-pr', repo_id: String(repoId), event_type: 'pull_request' }])
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledWith(repoId, 7))
  })

  it('US-02 AC1: submitted review applies the PR so the review request is refreshed', async () => {
    const res = await send('pull_request_review', {
      action: 'submitted',
      review: { state: 'approved' },
      pull_request: { number: 8 },
      repository,
    })
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledWith(repoId, 8))
  })

  it('US-08 AC2: comment on a PR applies the PR; comment on a plain issue does not', async () => {
    await send('issue_comment', { action: 'created', issue: { number: 5 }, repository })
    const res = await send('issue_comment', {
      action: 'created',
      issue: { number: 9, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/9' } },
      repository,
    })
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledWith(repoId, 9))
    expect(applyEvent).toHaveBeenCalledTimes(1)
    expect(await deliveryCount()).toBe(2)
  })

  it('US-09 AC1: push to main re-applies every open PR based on main', async () => {
    await insertPr(1, 'main')
    await insertPr(2, 'main')
    await insertPr(3, 'release')
    await insertPr(4, 'main', 'merged')
    const res = await send('push', { ref: 'refs/heads/main', repository })
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(2))
    expect(vi.mocked(applyEvent).mock.calls).toEqual([
      [repoId, 1],
      [repoId, 2],
    ])
  })

  it('US-09 AC1: one failing PR does not stop the others', async () => {
    await insertPr(1, 'main')
    await insertPr(2, 'main')
    vi.mocked(applyEvent).mockImplementation(async (_repo, n) => {
      if (n === 1) throw new Error('GitHub 502')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await send('push', { ref: 'refs/heads/main', repository })
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining('PR #1: GitHub 502')))
    errors.mockRestore()
  })

  it('US-02: answers 202 before processing finishes (GitHub 10-second limit)', async () => {
    vi.mocked(applyEvent).mockReturnValue(new Promise(() => undefined)) // never finishes
    const started = Date.now()
    const res = await send('pull_request', prPayload('synchronize'))
    expect(res.status).toBe(202)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('signed delivery without X-GitHub-Delivery returns 400 and writes nothing', async () => {
    const res = await send('pull_request', prPayload('opened'), { delivery: null })
    expect(res.status).toBe(400)
    expect(await deliveryCount()).toBe(0)
  })
})

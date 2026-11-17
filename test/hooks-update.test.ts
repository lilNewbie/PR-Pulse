import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import nock from 'nock'
import pool from '../server/src/db/pool'
import { encrypt } from '../server/src/lib/crypto'
import { updateAllHooks } from '../server/src/modules/team-repo/hooksUpdate'
import { HOOK_EVENTS } from '../server/src/modules/team-repo/connect'

const GITHUB_API = 'https://api.github.com'

async function cleanTables() {
  await pool.query('TRUNCATE TABLE repo_access, repos, sessions, members, users, teams RESTART IDENTITY CASCADE')
}

async function createUser(githubId: number, token: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (github_id, login, github_token_enc) VALUES ($1, $2, $3) RETURNING id',
    [githubId, `user-${githubId}`, encrypt(token)],
  )
  return Number(rows[0].id)
}

async function insertRepo(
  teamId: number,
  githubRepoId: number,
  name: string,
  hookId: number | null,
  connectedBy: number | null,
) {
  await pool.query(
    `INSERT INTO repos
       (team_id, github_repo_id, owner, name, hook_id, webhook_secret_enc, status, sync_status, connected_by)
     VALUES ($1, $2, 'acme', $3, $4, $5, 'connected', 'ok', $6)`,
    [teamId, githubRepoId, name, hookId, encrypt('secret'), connectedBy],
  )
}

describe('npm run hooks:update (US-12 setup)', () => {
  let teamId: number
  let lines: string[]
  const log = (line: string) => lines.push(line)

  beforeEach(async () => {
    await cleanTables()
    const { rows } = await pool.query<{ id: string }>("INSERT INTO teams (name) VALUES ('Team') RETURNING id")
    teamId = Number(rows[0].id)
    lines = []
    nock.disableNetConnect()
    nock.enableNetConnect(/127\.0\.0\.1|localhost/)
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  it('new connections subscribe to deployment_status', () => {
    expect(HOOK_EVENTS).toContain('deployment_status')
  })

  it("patches each repo's hook with the full events list using the connected_by token", async () => {
    const alice = await createUser(1, 'token-alice')
    const bob = await createUser(2, 'token-bob')
    await insertRepo(teamId, 101, 'api', 11, alice)
    await insertRepo(teamId, 102, 'web', 12, bob)

    const apiScope = nock(GITHUB_API, { reqheaders: { authorization: 'Bearer token-alice' } })
      .patch('/repos/acme/api/hooks/11', { events: HOOK_EVENTS })
      .reply(200, {})
    const webScope = nock(GITHUB_API, { reqheaders: { authorization: 'Bearer token-bob' } })
      .patch('/repos/acme/web/hooks/12', { events: HOOK_EVENTS })
      .reply(200, {})

    await expect(updateAllHooks(log)).resolves.toEqual({ updated: 2, failed: 0 })
    expect(apiScope.isDone() && webScope.isDone()).toBe(true)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^ok\s+acme\/api \(hook 11\)/)
  })

  it('logs a failing repo and keeps going with the rest', async () => {
    const alice = await createUser(1, 'token-alice')
    await insertRepo(teamId, 101, 'api', 11, alice)
    await insertRepo(teamId, 102, 'gone', 12, alice)
    await insertRepo(teamId, 103, 'orphan', 13, null)
    await insertRepo(teamId, 104, 'web', 14, alice)

    nock(GITHUB_API).patch('/repos/acme/api/hooks/11').reply(200, {})
    nock(GITHUB_API).patch('/repos/acme/gone/hooks/12').reply(404, { message: 'Not Found' })
    const lastScope = nock(GITHUB_API).patch('/repos/acme/web/hooks/14').reply(200, {})

    await expect(updateAllHooks(log)).resolves.toEqual({ updated: 2, failed: 2 })
    expect(lastScope.isDone()).toBe(true)
    expect(lines).toEqual([
      expect.stringMatching(/^ok\s+acme\/api/),
      'FAIL  acme/gone (hook 12): GitHub returned 404',
      'FAIL  acme/orphan (hook 13): no connected_by user to act as',
      expect.stringMatching(/^ok\s+acme\/web/),
    ])
    expect(lines.join('\n')).not.toContain('token-alice')
  })

  it('skips repos with no hook', async () => {
    const alice = await createUser(1, 'token-alice')
    await insertRepo(teamId, 101, 'api', null, alice)

    await expect(updateAllHooks(log)).resolves.toEqual({ updated: 0, failed: 0 })
    expect(lines).toEqual([])
  })
})

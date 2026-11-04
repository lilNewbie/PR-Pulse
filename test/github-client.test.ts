import { describe, it, expect, afterEach, vi } from 'vitest'
import nock from 'nock'
import { createHook, deleteHook, getRepo, GitHubError } from '../server/src/github/client'

const GITHUB_API = 'https://api.github.com'
const HOOK_INPUT = {
  url: 'https://example.com/webhooks/github',
  secret: 'webhook-secret',
  events: ['pull_request', 'pull_request_review', 'issue_comment', 'push'],
}

describe('GitHub client', () => {
  afterEach(() => {
    nock.cleanAll()
    vi.useRealTimers()
  })

  it('getRepo sends the token and returns the repo', async () => {
    const repo = { id: 42, owner: { login: 'acme' }, name: 'api', permissions: { admin: true } }
    nock(GITHUB_API, { reqheaders: { authorization: 'Bearer token' } })
      .get('/repos/acme/api')
      .reply(200, repo)

    await expect(getRepo('token', 'acme', 'api')).resolves.toEqual(repo)
  })

  it('throws GitHubError with the status on a non-2xx response', async () => {
    nock(GITHUB_API).get('/repos/acme/api').reply(404, { message: 'Not Found' })

    const err = await getRepo('token', 'acme', 'api').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(GitHubError)
    expect(err).toMatchObject({ status: 404, rateLimitReset: undefined })
  })

  it('reads rateLimitReset from a rate-limited response', async () => {
    nock(GITHUB_API).get('/repos/acme/api').reply(403, { message: 'rate limited' }, {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '1800000000',
    })

    const err = await getRepo('token', 'acme', 'api').catch((e: unknown) => e)

    expect(err).toMatchObject({ status: 403, rateLimitReset: new Date(1800000000 * 1000) })
  })

  it('leaves rateLimitReset unset on a 403 with requests remaining', async () => {
    nock(GITHUB_API).get('/repos/acme/api').reply(403, { message: 'forbidden' }, {
      'X-RateLimit-Remaining': '10',
      'X-RateLimit-Reset': '1800000000',
    })

    const err = await getRepo('token', 'acme', 'api').catch((e: unknown) => e)

    expect(err).toMatchObject({ status: 403, rateLimitReset: undefined })
  })

  it('throws GitHubError with status 0 when the request fails', async () => {
    nock(GITHUB_API).get('/repos/acme/api').replyWithError('socket hang up')

    const err = await getRepo('token', 'acme', 'api').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(GitHubError)
    expect(err).toMatchObject({ status: 0 })
  })

  it('times out after 8 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    nock(GITHUB_API).get('/repos/acme/api').reply(200, {})

    await getRepo('token', 'acme', 'api')

    expect(timeout).toHaveBeenCalledWith(8000)
  })

  it('createHook posts a JSON webhook and returns its id', async () => {
    nock(GITHUB_API)
      .post('/repos/acme/api/hooks', {
        name: 'web',
        active: true,
        events: HOOK_INPUT.events,
        config: { url: HOOK_INPUT.url, secret: HOOK_INPUT.secret, content_type: 'json' },
      })
      .reply(201, { id: 99 })

    await expect(createHook('token', 'acme', 'api', HOOK_INPUT)).resolves.toBe(99)
  })

  it('deleteHook handles the empty 204 response', async () => {
    nock(GITHUB_API).delete('/repos/acme/api/hooks/99').reply(204)

    await expect(deleteHook('token', 'acme', 'api', 99)).resolves.toBeUndefined()
  })
})

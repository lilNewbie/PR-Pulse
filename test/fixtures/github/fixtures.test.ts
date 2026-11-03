// Owned by Mandaar. Guards the recorded GitHub fixtures: no secrets, replayable signatures.
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  EMAIL_RE,
  IPV4_RE,
  REDACTED,
  REDACTED_EMAIL,
  REDACTED_IP,
  TOKEN_RE,
  sanitizeJson,
  sign,
  toWebhookFixture,
  type Json,
} from './tools/sanitize'
import { fixtureName } from './tools/names'

function jsonFiles(dir: string): string[] {
  const full = join(__dirname, dir)
  return existsSync(full)
    ? readdirSync(full).filter((f) => f.endsWith('.json')).map((f) => join(full, f))
    : []
}

const webhookFiles = jsonFiles('webhooks')
const allFiles = [...webhookFiles, ...jsonFiles('api')]

describe('fixture sanitizer', () => {
  it('redacts emails, tokens and secret-named keys', () => {
    const out = sanitizeJson({
      author: { email: 'dev@company.com', name: 'Dev' },
      message: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked',
      config: { secret: 's3cr3t', url: 'https://smee.io/x' },
      noreply: '123+dev@users.noreply.github.com',
      rateLimit: 'API rate limit exceeded for 216.165.95.146.',
    }) as { [k: string]: { [k: string]: Json } | string }
    expect(out).toEqual({
      author: { email: REDACTED_EMAIL, name: 'Dev' },
      message: `token ${REDACTED} leaked`,
      config: { secret: REDACTED, url: 'https://smee.io/x' },
      noreply: REDACTED_EMAIL,
      rateLimit: `API rate limit exceeded for ${REDACTED_IP}.`,
    })
  })

  it('re-signs webhook bodies and drops unlisted headers', () => {
    const fx = toWebhookFixture(
      { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=real', cookie: 'a=b', host: 'localhost' },
      { ref: 'refs/heads/main', pusher: { email: 'dev@company.com' } },
    )
    expect(fx.headers).toEqual({
      'x-github-event': 'push',
      'x-hub-signature-256': sign(JSON.stringify(fx.body)),
    })
  })

  it('names deliveries by event, action and variant', () => {
    expect(fixtureName('pull_request', { action: 'closed', pull_request: { merged: true } })).toBe(
      'pull_request.closed.merged',
    )
    expect(fixtureName('pull_request_review', { action: 'submitted', review: { state: 'APPROVED' } })).toBe(
      'pull_request_review.submitted.approved',
    )
    expect(fixtureName('issue_comment', { action: 'created', issue: {} })).toBeNull()
    expect(fixtureName('push', { ref: 'refs/heads/main' })).toBe('push.main')
  })
})

describe('recorded fixtures', () => {
  it.each(allFiles.length ? allFiles : ['(none recorded yet)'])('%s has no emails or tokens', (file) => {
    if (!existsSync(file)) return
    const text = readFileSync(file, 'utf8')
    const emails = (text.match(EMAIL_RE) ?? []).filter((e) => e !== REDACTED_EMAIL)
    expect(emails).toEqual([])
    expect(text.match(TOKEN_RE)).toBeNull()
    expect((text.match(IPV4_RE) ?? []).filter((ip) => ip !== REDACTED_IP)).toEqual([])
  })

  it.each(webhookFiles.length ? webhookFiles : ['(none recorded yet)'])(
    '%s is signed with the fixture secret',
    (file) => {
      if (!existsSync(file)) return
      const fx = JSON.parse(readFileSync(file, 'utf8')) as { headers: Record<string, string>; body: Json }
      expect(fx.headers['x-hub-signature-256']).toBe(sign(JSON.stringify(fx.body)))
    },
  )
})

// Owned by Mandaar. Shared by the fixture recorders and the fixture guard test.
import { createHmac } from 'crypto'

// Every webhook fixture is re-signed with this secret, so tests can replay it as-is.
// The signature covers JSON.stringify(body) exactly.
export const FIXTURE_WEBHOOK_SECRET = 'test-webhook-secret'

export const REDACTED = '[REDACTED]'
export const REDACTED_EMAIL = 'redacted@example.com'
// TEST-NET-3 documentation address. GitHub puts the caller's IP in rate-limit messages.
export const REDACTED_IP = '203.0.113.1'

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
export const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
// GitHub token formats: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained (github_pat_).
export const TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g

const SECRET_KEYS = /^(token|access_token|secret|password|authorization|client_secret)$/i

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function sanitizeString(s: string): string {
  return s.replace(TOKEN_RE, REDACTED).replace(EMAIL_RE, REDACTED_EMAIL).replace(IPV4_RE, REDACTED_IP)
}

export function sanitizeJson(value: Json): Json {
  if (typeof value === 'string') return sanitizeString(value)
  if (Array.isArray(value)) return value.map(sanitizeJson)
  if (value && typeof value === 'object') {
    const out: { [key: string]: Json } = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) && v !== null ? REDACTED : sanitizeJson(v)
    }
    return out
  }
  return value
}

// Headers worth keeping. Everything else (smee/proxy noise, cookies, auth) is dropped.
const WEBHOOK_HEADERS = [
  'content-type',
  'user-agent',
  'x-github-delivery',
  'x-github-event',
  'x-github-hook-id',
  'x-github-hook-installation-target-id',
  'x-github-hook-installation-target-type',
]

const API_HEADERS = [
  'content-type',
  'link',
  'retry-after',
  'x-github-media-type',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-ratelimit-used',
]

function pick(headers: Record<string, string>, keep: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of keep) {
    const v = headers[name]
    if (v !== undefined) out[name] = sanitizeString(v)
  }
  return out
}

export function sign(rawBody: string, secret = FIXTURE_WEBHOOK_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
}

export interface WebhookFixture {
  headers: Record<string, string>
  body: Json
}

export function toWebhookFixture(headers: Record<string, string>, body: Json): WebhookFixture {
  const cleanBody = sanitizeJson(body)
  const cleanHeaders = pick(headers, WEBHOOK_HEADERS)
  cleanHeaders['x-hub-signature-256'] = sign(JSON.stringify(cleanBody))
  return { headers: cleanHeaders, body: cleanBody }
}

export interface ApiFixture {
  request: { method: string; path: string }
  status: number
  headers: Record<string, string>
  body: Json
}

export function toApiFixture(
  method: string,
  path: string,
  status: number,
  headers: Record<string, string>,
  body: Json,
): ApiFixture {
  return {
    request: { method, path },
    status,
    headers: pick(headers, API_HEADERS),
    body: sanitizeJson(body),
  }
}

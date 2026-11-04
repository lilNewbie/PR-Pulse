// Owned by Mandaar. Records GitHub REST API responses as fixtures.
//
//   GITHUB_TOKEN=<token with repo scope> FIXTURE_PR=<open PR number> \
//     npx tsx test/fixtures/github/tools/record-api.ts
//
// Optional: FIXTURE_REPO (default pr-pulse-test/sandbox), SKIP_RATE_LIMIT=1,
// FIXTURE_OUT_DIR (for a dry run). GITHUB_TOKEN can be left out for a public repo.
// The token is only sent to api.github.com; it is never written to disk.
// Output goes to test/fixtures/github/api/<name>.json, sanitized.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { toApiFixture, type Json } from './sanitize'

const API = 'https://api.github.com'
const OUT_DIR = process.env.FIXTURE_OUT_DIR
  ? join(process.env.FIXTURE_OUT_DIR, 'api')
  : join(__dirname, '..', 'api')

interface Recorded {
  status: number
  headers: Record<string, string>
  body: Json
}

async function get(path: string, token?: string): Promise<Recorded> {
  const res = await fetch(API + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pr-pulse-fixture-recorder',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
  const text = await res.text()
  let body: Json
  try {
    body = JSON.parse(text) as Json
  } catch {
    body = text
  }
  return { status: res.status, headers, body }
}

function save(name: string, path: string, r: Recorded): void {
  const file = join(OUT_DIR, `${name}.json`)
  writeFileSync(file, JSON.stringify(toApiFixture('GET', path, r.status, r.headers, r.body), null, 2) + '\n')
  console.log(`saved  ${name}  (${r.status} GET ${path})`)
}

function field(body: Json, ...keys: string[]): Json | undefined {
  let cur: Json | undefined = body
  for (const k of keys) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

function require200(r: Recorded, what: string): void {
  if (r.status !== 200) {
    throw new Error(`${what} returned ${r.status}: ${JSON.stringify(field(r.body, 'message') ?? r.body)}`)
  }
}

async function recordRateLimit(repoPath: string): Promise<void> {
  // Unauthenticated requests share a 60/hour limit per IP. Burn through it to get a real 403/429.
  const path = `${repoPath}/pulls?state=open`
  const before = await get('/rate_limit') // does not count against the limit
  const left = Number(field(before.body, 'resources', 'core', 'remaining') ?? 60)
  console.log(`rate limit: ${left} unauthenticated requests left; using them up…`)
  for (let i = 0; i <= left + 5; i++) {
    const r = await get(path)
    if ((r.status === 403 || r.status === 429) && r.headers['x-ratelimit-remaining'] === '0') {
      save('rate-limited.403', path, r)
      return
    }
  }
  console.log('warn   never got a rate-limited response; run again later or with SKIP_RATE_LIMIT=1')
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN
  const prNumber = process.env.FIXTURE_PR
  const repo = process.env.FIXTURE_REPO ?? 'pr-pulse-test/sandbox'
  if (!prNumber) {
    console.error('Set FIXTURE_PR (an open PR in the test repo), and GITHUB_TOKEN for a private repo.')
    process.exit(1)
  }
  if (!token) console.log('note   no GITHUB_TOKEN; unauthenticated (public repos only, 60 requests/hour)')
  mkdirSync(OUT_DIR, { recursive: true })
  const repoPath = `/repos/${repo}`

  // List of open PRs (the sync's main call).
  const listPath = `${repoPath}/pulls?state=open&per_page=100`
  const list = await get(listPath, token)
  require200(list, 'list open PRs')
  save('pulls.list-open', listPath, list)

  // A two-page sample so the sync's pagination can be tested.
  if (Array.isArray(list.body) && list.body.length >= 2) {
    for (const page of [1, 2]) {
      const p = `${repoPath}/pulls?state=open&per_page=1&page=${page}`
      save(`pulls.list-open.page${page}`, p, await get(p, token))
    }
  } else {
    console.log('note   fewer than 2 open PRs, skipping the pagination sample')
  }

  // One PR. GitHub computes `mergeable` in the background, so the first read can be null.
  const prPath = `${repoPath}/pulls/${prNumber}`
  let pr = await get(prPath, token)
  require200(pr, `PR #${prNumber}`)
  for (let i = 0; i < 5 && field(pr.body, 'mergeable') === null; i++) {
    save('pull.mergeable-null', prPath, pr)
    await new Promise((r) => setTimeout(r, 2000))
    pr = await get(prPath, token)
  }
  save('pull', prPath, pr)

  const reviewsPath = `${prPath}/reviews?per_page=100`
  save('pull.reviews', reviewsPath, await get(reviewsPath, token))

  const base = String(field(pr.body, 'base', 'ref'))
  // Same-repo PRs compare by branch name; fork PRs need owner:branch.
  const sameRepo = field(pr.body, 'head', 'repo', 'id') === field(pr.body, 'base', 'repo', 'id')
  const head = String(field(pr.body, 'head', sameRepo ? 'ref' : 'label'))
  const comparePath = `${repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  save('compare', comparePath, await get(comparePath, token))

  if (process.env.SKIP_RATE_LIMIT !== '1') await recordRateLimit(repoPath)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

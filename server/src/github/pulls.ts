// Owned by Mandaar. GitHub REST calls used by the PR Sync Service.
// TODO: switch to Kaushik's githubFetch (github/client.ts) once it is on main.

const API = 'https://api.github.com'
const TIMEOUT_MS = 10_000

export class GitHubApiError extends Error {
  constructor(
    readonly status: number, // 0 = timeout or network failure
    readonly rateLimitResetAt: Date | null = null, // set only when GitHub says we are rate limited
  ) {
    super(status === 0 ? 'GitHub request failed or timed out' : `GitHub responded ${status}`)
    this.name = 'GitHubApiError'
  }

  get isRateLimited(): boolean {
    return this.rateLimitResetAt !== null
  }
}

function rateLimitReset(res: Response): Date | null {
  if (res.status !== 403 && res.status !== 429) return null
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000)
  }
  const retryAfter = Number(res.headers.get('retry-after')) // secondary rate limit
  if (Number.isFinite(retryAfter) && retryAfter > 0) return new Date(Date.now() + retryAfter * 1000)
  return null
}

async function get(token: string, pathOrUrl: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'pr-pulse',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new GitHubApiError(0)
  }
  if (!res.ok) throw new GitHubApiError(res.status, rateLimitReset(res))
  return res
}

function nextLink(res: Response, rel = 'next'): string | null {
  const link = res.headers.get('link')
  const match = link?.split(',').find((part) => part.includes(`rel="${rel}"`))
  return match ? (match.match(/<([^>]+)>/)?.[1] ?? null) : null
}

// Follows Link: rel="next" (the URL GitHub gives, which may use /repositories/<id>/...).
async function getAllPages<T>(token: string, path: string): Promise<T[]> {
  const items: T[] = []
  let url: string | null = path
  while (url) {
    const res = await get(token, url)
    items.push(...((await res.json()) as T[]))
    url = nextLink(res)
  }
  return items
}

export interface GhUser {
  id: number
  login: string
}

export interface GhPull {
  number: number
  title: string
  state: 'open' | 'closed'
  draft: boolean
  user: GhUser
  created_at: string
  updated_at: string
  merged_at: string | null
  merge_commit_sha: string | null
  mergeable?: boolean | null // only on the single-PR endpoint
  additions?: number // only on the single-PR endpoint
  deletions?: number // only on the single-PR endpoint
  requested_reviewers: GhUser[]
  base: { ref: string }
  head: { sha: string }
}

export interface GhReview {
  id: number
  user: GhUser | null
  state: string // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submitted_at?: string | null
}

const repoPath = (owner: string, name: string) => `/repos/${owner}/${name}`

export async function listOpenPulls(token: string, owner: string, name: string): Promise<GhPull[]> {
  return getAllPages<GhPull>(token, `${repoPath(owner, name)}/pulls?state=open&per_page=100`)
}

export async function getPull(token: string, owner: string, name: string, n: number): Promise<GhPull> {
  return (await (await get(token, `${repoPath(owner, name)}/pulls/${n}`)).json()) as GhPull
}

export async function listReviews(token: string, owner: string, name: string, n: number): Promise<GhReview[]> {
  return getAllPages<GhReview>(token, `${repoPath(owner, name)}/pulls/${n}/reviews?per_page=100`)
}

// Commits the base branch has that the PR's head doesn't.
export async function getBehindBy(token: string, owner: string, name: string, base: string, headSha: string): Promise<number> {
  const res = await get(token, `${repoPath(owner, name)}/compare/${encodeURIComponent(base)}...${headSha}`)
  return ((await res.json()) as { behind_by: number }).behind_by
}

// When the PR's latest commit was made.
export async function getCommitDate(token: string, owner: string, name: string, sha: string): Promise<string> {
  const res = await get(token, `${repoPath(owner, name)}/commits/${sha}`)
  return ((await res.json()) as { commit: { committer: { date: string } } }).commit.committer.date
}

// When the PR's latest conversation comment was posted, or null. Comments come oldest first, so read the last page.
export async function getLatestCommentDate(token: string, owner: string, name: string, n: number): Promise<string | null> {
  const first = await get(token, `${repoPath(owner, name)}/issues/${n}/comments?per_page=100`)
  const last = nextLink(first, 'last')
  const page = (await (last ? await get(token, last) : first).json()) as { created_at: string }[]
  return page.length ? page[page.length - 1].created_at : null
}

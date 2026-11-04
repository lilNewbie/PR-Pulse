const GITHUB_API = 'https://api.github.com'
const TIMEOUT_MS = 8000

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly rateLimitReset?: Date,
  ) {
    super(`GitHub request failed: ${status}`)
    this.name = 'GitHubError'
  }
}

export interface GitHubRepo {
  id: number
  owner: { login: string }
  name: string
  permissions?: { admin?: boolean }
}

export interface HookInput {
  url: string
  secret: string
  events: string[]
}

function rateLimitResetFrom(res: Response): Date | undefined {
  if (res.headers.get('x-ratelimit-remaining') !== '0') return undefined
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  return reset ? new Date(reset * 1000) : undefined
}

// status 0 means GitHub never answered (timeout or network error).
export async function githubFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        ...init?.headers,
      },
    })
  } catch {
    throw new GitHubError(0)
  }
  if (!res.ok) throw new GitHubError(res.status, rateLimitResetFrom(res))
  return res
}

export async function getRepo(token: string, owner: string, name: string): Promise<GitHubRepo> {
  const res = await githubFetch(token, `/repos/${owner}/${name}`)
  return (await res.json()) as GitHubRepo
}

export async function createHook(
  token: string,
  owner: string,
  name: string,
  hook: HookInput,
): Promise<number> {
  const res = await githubFetch(token, `/repos/${owner}/${name}/hooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: hook.events,
      config: { url: hook.url, secret: hook.secret, content_type: 'json' },
    }),
  })
  const data = (await res.json()) as { id: number }
  return data.id
}

export async function deleteHook(
  token: string,
  owner: string,
  name: string,
  hookId: number,
): Promise<void> {
  await githubFetch(token, `/repos/${owner}/${name}/hooks/${hookId}`, { method: 'DELETE' })
}

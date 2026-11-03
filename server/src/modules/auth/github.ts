const GITHUB_OAUTH_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_API = 'https://api.github.com'

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID ?? '',
    scope: 'read:user repo admin:repo_hook',
    state,
  })
  return `${GITHUB_OAUTH_URL}?${params}`
}

export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  })
  if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status}`)
  const data = (await res.json()) as { access_token?: string; error?: string }
  if (!data.access_token) throw new Error(data.error ?? 'No access_token in response')
  return data.access_token
}

export async function getGithubUser(token: string): Promise<{ id: number; login: string }> {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`)
  const data = (await res.json()) as { id: number; login: string }
  return { id: data.id, login: data.login }
}

export async function listUserRepoIds(token: string): Promise<number[]> {
  const ids: number[] = []
  let page = 1
  while (true) {
    const res = await fetch(`${GITHUB_API}/user/repos?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) throw new Error(`GitHub repo list failed: ${res.status}`)
    const repos = (await res.json()) as { id: number }[]
    for (const r of repos) ids.push(r.id)
    if (repos.length < 100) break
    page++
  }
  return ids
}

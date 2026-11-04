import crypto from 'crypto'
import { createHook, deleteHook, getRepo, GitHubError } from '../../github/client'
import { getGitHubToken } from '../auth/token'
import { encrypt } from '../../lib/crypto'
import { findRepoByGithubId, insertConnectingRepo, RepoAlreadyConnectedError } from '../../db/repos'
import { syncRepo } from '../../sync'

export const HOOK_EVENTS = ['pull_request', 'pull_request_review', 'issue_comment', 'push']

export type ConnectResult =
  | { ok: true; repoId: number }
  | { ok: false; status: number; error: string }

const GITHUB_UNAVAILABLE = { ok: false, status: 502, error: "Couldn't reach GitHub, try again" } as const
const NOT_FOUND = { ok: false, status: 404, error: 'Repository not found' } as const
const NOT_ADMIN = { ok: false, status: 403, error: 'You need admin access to this repo on GitHub' } as const
const ALREADY_CONNECTED = { ok: false, status: 409, error: 'This repository is already connected' } as const

// Diagram 4. The caller has already passed requireRole('lead').
export async function connectRepo(userId: number, owner: string, name: string): Promise<ConnectResult> {
  const webhookUrl = process.env.WEBHOOK_URL
  if (!webhookUrl) throw new Error('WEBHOOK_URL is not set')

  const token = await getGitHubToken(userId)

  let repo
  try {
    repo = await getRepo(token, owner, name)
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err
    return err.status === 404 ? NOT_FOUND : GITHUB_UNAVAILABLE
  }

  if (repo.permissions?.admin !== true) return NOT_ADMIN
  if (await findRepoByGithubId(repo.id)) return ALREADY_CONNECTED

  const secret = crypto.randomBytes(32).toString('hex')
  let hookId: number
  try {
    hookId = await createHook(token, repo.owner.login, repo.name, {
      url: webhookUrl,
      secret,
      events: HOOK_EVENTS,
    })
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err
    return GITHUB_UNAVAILABLE
  }

  let repoId: number
  try {
    repoId = await insertConnectingRepo({
      githubRepoId: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      hookId,
      webhookSecretEnc: encrypt(secret),
      connectedBy: userId,
    })
  } catch (err) {
    // Don't leave a webhook on GitHub for a repo we didn't store.
    await deleteHook(token, repo.owner.login, repo.name, hookId).catch((deleteErr: Error) => {
      console.error(`Failed to delete hook ${hookId} on ${repo.owner.login}/${repo.name}:`, deleteErr.message)
    })
    if (err instanceof RepoAlreadyConnectedError) return ALREADY_CONNECTED
    throw err
  }

  syncRepo(repoId, 'initial').catch((err: Error) => {
    console.error(`Initial sync failed for repo ${repoId}:`, err.message)
  })

  return { ok: true, repoId }
}

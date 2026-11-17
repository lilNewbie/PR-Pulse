import { GitHubError, updateHookEvents } from '../../github/client'
import { getGitHubToken } from '../auth/token'
import { listReposWithHooks } from '../../db/repos'
import { HOOK_EVENTS } from './connect'

export interface HooksUpdateSummary {
  updated: number
  failed: number
}

function describeError(err: unknown): string {
  if (err instanceof GitHubError) {
    return err.status === 0 ? "couldn't reach GitHub" : `GitHub returned ${err.status}`
  }
  return err instanceof Error ? err.message : String(err)
}

// Patches every repo's webhook to the full HOOK_EVENTS list, using the token of the
// Lead who connected it. Logs one line per repo and keeps going when one fails.
// Never logs tokens: errors are reduced to a status code or message.
export async function updateAllHooks(
  log: (line: string) => void = console.log,
): Promise<HooksUpdateSummary> {
  const repos = await listReposWithHooks()
  const summary: HooksUpdateSummary = { updated: 0, failed: 0 }

  for (const repo of repos) {
    const label = `${repo.owner}/${repo.name} (hook ${repo.hook_id})`
    try {
      if (repo.connected_by === null) throw new Error('no connected_by user to act as')
      const token = await getGitHubToken(repo.connected_by)
      await updateHookEvents(token, repo.owner, repo.name, repo.hook_id, HOOK_EVENTS)
      summary.updated++
      log(`ok    ${label}: events = ${HOOK_EVENTS.join(', ')}`)
    } catch (err) {
      summary.failed++
      log(`FAIL  ${label}: ${describeError(err)}`)
    }
  }

  return summary
}

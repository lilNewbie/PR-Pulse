import { useEffect, useState } from 'react'
import type { PrSummary, WaitingOnItem } from 'shared'
import { apiFetch } from '../api/client'

// Module-level cache so all mounted instances share one fetch per page load.
// Cleared after the fetch settles so a navigation back to My PRs gets fresh data.
let cachedPromise: Promise<WaitingOnItem[]> | null = null
function fetchWaitingOn(): Promise<WaitingOnItem[]> {
  if (!cachedPromise) {
    cachedPromise = apiFetch<WaitingOnItem[]>('/api/my-prs/waiting').finally(() => {
      cachedPromise = null
    })
  }
  return cachedPromise
}

type State =
  | { status: 'loading' }
  | { status: 'ok'; item: WaitingOnItem | undefined }
  | { status: 'error' }

export default function WaitingOn({ pr }: { pr: PrSummary }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    fetchWaitingOn()
      .then((items) => {
        setState({ status: 'ok', item: items.find((i) => i.prId === pr.id) })
      })
      .catch(() => setState({ status: 'error' }))
  }, [pr.id])

  if (pr.isDraft) return null
  if (state.status === 'loading') return null
  if (state.status === 'error') return null

  const item = state.item
  if (!item) return null

  if (item.noReviewerRequested) {
    return <p className="waiting-on waiting-on-none">No reviewer requested</p>
  }

  return (
    <ul className="waiting-on">
      {item.reviewers.map((r) => (
        <li key={r.login} className="waiting-on-reviewer">
          Waiting on @{r.login} · {r.waitingHours}h
          {r.overloaded ? ` · Overloaded (${r.openRequests} open)` : ''}
        </li>
      ))}
    </ul>
  )
}

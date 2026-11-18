import { useEffect, useState } from 'react'
import type { PrSummary, WaitingOnItem, WaitingOnReviewer } from 'shared'
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

function waitSeverity(hours: number): 'low' | 'mid' | 'high' | 'critical' {
  if (hours >= 72) return 'critical'
  if (hours >= 24) return 'high'
  if (hours >= 4)  return 'mid'
  return 'low'
}

function ReviewerRow({ r }: { r: WaitingOnReviewer }) {
  const initial = r.login[0].toUpperCase()
  const severity = waitSeverity(r.waitingHours)
  return (
    <div className="waiting-row">
      <span className="reviewer-avatar">{initial}</span>
      <span className="reviewer-login">@{r.login}</span>
      <span className={`wait-pill wait-pill--${severity}`}>
        ⏱ {r.waitingHours}h
      </span>
      {r.overloaded && (
        <span className="overload-tag">
          <span className="overload-icon">⚠</span>
          Overloaded · {r.openRequests} open
        </span>
      )}
    </div>
  )
}

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
    return (
      <div className="waiting-on-none">
        <span className="waiting-on-none-icon">↗</span>
        No reviewer requested
      </div>
    )
  }

  return (
    <div className="waiting-on">
      {item.reviewers.map((r) => (
        <ReviewerRow key={r.login} r={r} />
      ))}
    </div>
  )
}

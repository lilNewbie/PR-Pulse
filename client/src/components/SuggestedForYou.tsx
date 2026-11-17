// Owned by Mandaar. "Suggested for you" (US-11, US-19): open PRs that change files I worked on recently,
// where I have the lightest review load among the recent committers.
// Mounted by Alan on the Review Queue page.
import { useEffect, useState } from 'react'
import type { SuggestionItem, SuggestionReason } from 'shared'
import { apiFetch } from '../api/client'

type State =
  | { status: 'loading' }
  | { status: 'ok'; items: SuggestionItem[] }
  | { status: 'error'; message: string }

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function Reason({ reason }: { reason: SuggestionReason }) {
  return (
    <div className="pr-meta">
      You changed <code>{reason.path}</code> on {formatDate(reason.lastCommitAt)} · {reason.openRequests} open{' '}
      {reason.openRequests === 1 ? 'review' : 'reviews'}
    </div>
  )
}

export default function SuggestedForYou() {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    apiFetch<SuggestionItem[]>('/api/suggestions')
      .then((items) => setState({ status: 'ok', items }))
      .catch((err: unknown) =>
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong' }),
      )
  }, [])

  if (state.status === 'loading') return null

  return (
    <section>
      <h2 className="page-title">Suggested for you</h2>
      {state.status === 'error' ? (
        <p className="text-error">Couldn't load suggestions: {state.message}</p>
      ) : state.items.length === 0 ? (
        <p className="text-muted">No suggestions right now.</p>
      ) : (
        <ul className="pr-list">
          {state.items.map((pr) => (
            <li key={pr.id} className="pr-item">
              <div className="pr-title">
                <a href={pr.url} target="_blank" rel="noreferrer">{pr.title}</a>
              </div>
              <div className="pr-meta">
                {pr.repo} #{pr.number} · by {pr.authorLogin} · {pr.linesChanged} lines
              </div>
              {pr.reasons.map((r) => <Reason key={r.path} reason={r} />)}
              {pr.reviewRequested && (
                <div className="pr-badges">
                  <span className="badge badge-warn">Review requested</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

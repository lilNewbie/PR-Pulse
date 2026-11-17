// Owned by Mandaar. "Suggested for you" (US-11, US-19, US-20): open PRs that change files I worked on recently,
// where I have the lightest review load among the recent committers. "Not a good fit" dismisses a reason's
// directory for 30 days.
// Mounted by Alan on the Review Queue page.
import { useEffect, useState } from 'react'
import type { SuggestionItem, SuggestionReason } from 'shared'
import { apiFetch } from '../api/client'

type State =
  | { status: 'loading' }
  | { status: 'ok'; items: SuggestionItem[] }
  | { status: 'error'; message: string }

// Same rule as the server's directoryOf (design-extension 1).
const directoryOf = (path: string) => (path.includes('/') ? path.replace(/\/[^/]*$/, '') || '/' : '/')

// After dismissing `path` in `repo`, the server ignores every file in that directory for me, so drop those reasons
// everywhere in that repo, and drop any PR left without a reason.
function withoutDirectory(items: SuggestionItem[], repo: string, path: string): SuggestionItem[] {
  const dir = directoryOf(path)
  return items
    .map((pr) => (pr.repo === repo ? { ...pr, reasons: pr.reasons.filter((r) => directoryOf(r.path) !== dir) } : pr))
    .filter((pr) => pr.reasons.length > 0)
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function Reason({ reason, onDismiss }: { reason: SuggestionReason; onDismiss: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dismiss = () => {
    setBusy(true)
    setError(null)
    onDismiss().catch((err: unknown) => {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Something went wrong')
    })
  }

  return (
    <div className="pr-meta">
      You changed <code>{reason.path}</code> on {formatDate(reason.lastCommitAt)} · {reason.openRequests} open{' '}
      {reason.openRequests === 1 ? 'review' : 'reviews'}{' '}
      <button type="button" className="btn-link" onClick={dismiss} disabled={busy}>
        Not a good fit
      </button>
      {error && <span className="text-error"> Couldn't dismiss: {error}</span>}
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

  const dismiss = async (pr: SuggestionItem, path: string) => {
    await apiFetch<void>(`/api/suggestions/${pr.id}/dismiss`, { method: 'POST', body: JSON.stringify({ path }) })
    setState((s) => (s.status === 'ok' ? { status: 'ok', items: withoutDirectory(s.items, pr.repo, path) } : s))
  }

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
              {pr.reasons.map((r) => (
                <Reason key={r.path} reason={r} onDismiss={() => dismiss(pr, r.path)} />
              ))}
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

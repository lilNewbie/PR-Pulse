// Owned by Kaushik. US-18 Team bottleneck view: route /team, Lead only (design-extension 3, 4.3, 5).
import { useEffect, useState } from 'react'
import { Navigate, NavLink } from 'react-router-dom'
import type { BottleneckResponse, ReviewerLoad } from 'shared'
import { apiFetch, ApiClientError } from '../api/client'
import { useMe } from '../hooks/useMe'

export const LEAD_ONLY_MESSAGE = 'Only a Lead can view team bottlenecks'

const ROLE_LABELS: Record<ReviewerLoad['role'], string> = {
  lead: 'Lead',
  reviewer: 'Reviewer',
  pr_author: 'PR Author',
}

// null means "All repositories".
export function bottlenecksPath(repoId: number | null): string {
  return repoId === null ? '/api/team/bottlenecks' : `/api/team/bottlenecks?repoId=${repoId}`
}

/** "Team" nav link, shown to Leads only. */
export function TeamNavLink() {
  const me = useMe()
  if (me.status !== 'ok' || me.me.role !== 'lead') return null
  return (
    <NavLink to="/team" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
      Team
    </NavLink>
  )
}

function ReviewerTable({ reviewers }: { reviewers: ReviewerLoad[] }) {
  if (reviewers.length === 0) return <p className="text-muted">No open review requests</p>

  // Rows stay in the API's order: highest load first (design-extension 4.3).
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="queue-table" aria-label="Reviewer load">
        <thead>
          <tr>
            <th>Reviewer</th>
            <th>Role</th>
            <th>Open requests</th>
            <th>Oldest wait</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {reviewers.map((reviewer) => (
            <tr key={reviewer.login}>
              <td className="queue-mono">{reviewer.login}</td>
              <td>{ROLE_LABELS[reviewer.role]}</td>
              <td>{reviewer.openRequests}</td>
              <td className="queue-mono">
                {reviewer.oldestWaitHours === null ? '—' : `${reviewer.oldestWaitHours}h`}
              </td>
              <td>{reviewer.overloaded && <span className="badge badge-danger">Overloaded</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StalePrTable({ prs }: { prs: BottleneckResponse['stalePrs'] }) {
  if (prs.length === 0) return <p className="text-muted">No stale PRs</p>

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="queue-table" aria-label="Stale PRs">
        <thead>
          <tr>
            <th>Title</th>
            <th>Repository</th>
            <th>Author</th>
            <th>Hours inactive</th>
          </tr>
        </thead>
        <tbody>
          {prs.map((pr) => (
            <tr key={pr.id}>
              <td>
                <a href={pr.url} target="_blank" rel="noreferrer">{pr.title}</a>
              </td>
              <td className="queue-mono">{pr.repo}</td>
              <td className="queue-mono">{pr.authorLogin}</td>
              <td>{pr.inactiveHours}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Presentational, exported for component tests with fixture data. */
export function TeamBottlenecks({ data }: { data: BottleneckResponse }) {
  return (
    <>
      <div className="connect-form" aria-label="Totals">
        <span><strong>Open PRs</strong> {data.totals.openPrs}</span>
        <span><strong>Open review requests</strong> {data.totals.openRequests}</span>
        <span><strong>Stale PRs</strong> {data.totals.stalePrs}</span>
      </div>

      <h3>Reviewer load</h3>
      <ReviewerTable reviewers={data.reviewers} />

      <h3>Stale PRs</h3>
      <StalePrTable prs={data.stalePrs} />
    </>
  )
}

type BottleneckState =
  | { status: 'loading' }
  | { status: 'loaded'; data: BottleneckResponse }
  | { status: 'forbidden' }
  | { status: 'error'; message: string }

export default function Team() {
  const me = useMe()
  const [repoId, setRepoId] = useState<number | null>(null)
  const [state, setState] = useState<BottleneckState>({ status: 'loading' })

  const signedIn = me.status === 'ok'
  const isLead = signedIn && me.me.role === 'lead'
  const repos = signedIn ? me.me.repos : []

  // Everyone who reaches /team asks the API; it is the permission check (403 for non-Leads, US-18 AC5).
  useEffect(() => {
    if (!signedIn) return

    let cancelled = false
    setState({ status: 'loading' })
    apiFetch<BottleneckResponse>(bottlenecksPath(repoId))
      .then((data) => {
        if (!cancelled) setState({ status: 'loaded', data })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiClientError && error.status === 403 && !isLead) {
          setState({ status: 'forbidden' })
        } else {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not load team bottlenecks',
          })
        }
      })
    return () => { cancelled = true }
  }, [signedIn, isLead, repoId])

  if (me.status === 'loading') return <p className="text-muted">Loading…</p>
  if (me.status === 'unauthenticated') return <Navigate to="/signin" replace />
  if (me.status === 'error') return <p className="text-error">Error: {me.message}</p>
  if (state.status === 'forbidden') return <p className="text-error">{LEAD_ONLY_MESSAGE}</p>

  return (
    <section>
      <h2 className="page-title">Team</h2>
      <div className="connect-form">
        <label htmlFor="team-repo">Repository</label>
        <select
          id="team-repo"
          value={repoId ?? ''}
          onChange={(event) => setRepoId(event.target.value === '' ? null : Number(event.target.value))}
        >
          <option value="">All repositories</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>{repo.fullName}</option>
          ))}
        </select>
      </div>
      {state.status === 'loaded' ? (
        <TeamBottlenecks data={state.data} />
      ) : state.status === 'error' ? (
        <p className="text-error">{state.message}</p>
      ) : (
        <p className="text-muted">Loading team bottlenecks…</p>
      )}
    </section>
  )
}

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

function waitSeverity(hours: number) {
  if (hours >= 72) return 'critical'
  if (hours >= 24) return 'high'
  if (hours >= 4)  return 'mid'
  return 'low'
}

function reqSeverity(n: number) {
  if (n >= 4) return 'critical'
  if (n >= 3) return 'mid'
  if (n >= 1) return 'low'
  return null
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
          </tr>
        </thead>
        <tbody>
          {reviewers.map((reviewer) => {
            const rs = reqSeverity(reviewer.openRequests)
            return (
              <tr key={reviewer.login} className={reviewer.overloaded ? 'reviewer-row--overloaded' : ''}>
                <td className="queue-mono reviewer-name-cell">
                  {reviewer.login}
                  {reviewer.overloaded && (
                    <span className="overload-tag" style={{ marginLeft: 8 }}>
                      <span className="overload-icon">⚠</span> Overloaded
                    </span>
                  )}
                </td>
                <td><span className="badge badge-muted">{ROLE_LABELS[reviewer.role]}</span></td>
                <td>
                  {rs ? (
                    <span className={`wait-pill wait-pill--${rs}`}>{reviewer.openRequests}</span>
                  ) : (
                    <span className="queue-mono">{reviewer.openRequests}</span>
                  )}
                </td>
                <td>
                  {reviewer.oldestWaitHours === null ? (
                    <span className="queue-mono">—</span>
                  ) : (
                    <span className={`wait-pill wait-pill--${waitSeverity(reviewer.oldestWaitHours)}`}>
                      ⏱ {reviewer.oldestWaitHours}h
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
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
            <th>Repository · Author</th>
            <th>Inactive</th>
          </tr>
        </thead>
        <tbody>
          {prs.map((pr) => (
            <tr key={pr.id}>
              <td>
                <a href={pr.url} target="_blank" rel="noreferrer">{pr.title}</a>
                <span className="pr-external-icon" aria-hidden>↗</span>
              </td>
              <td className="queue-meta-cell">
                <span className="queue-mono">{pr.repo}</span>
                <span className="queue-author">@{pr.authorLogin}</span>
              </td>
              <td>
                <span className={`wait-pill wait-pill--${waitSeverity(pr.inactiveHours)}`}>
                  ⏱ {pr.inactiveHours}h
                </span>
              </td>
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
      <div className="team-stat-cards" aria-label="Totals">
        <div className="team-stat-card">
          <span className="team-stat-label">Open PRs</span>{' '}
          <span className="team-stat-value">{data.totals.openPrs}</span>
        </div>
        <div className="team-stat-card">
          <span className="team-stat-label">Open review requests</span>{' '}
          <span className="team-stat-value">{data.totals.openRequests}</span>
        </div>
        <div className={`team-stat-card${data.totals.stalePrs > 0 ? ' team-stat-card--warn' : ''}`}>
          <span className="team-stat-label">Stale PRs</span>{' '}
          <span className="team-stat-value">{data.totals.stalePrs}</span>
        </div>
      </div>

      <h3 className="team-section-header">Reviewer load</h3>
      <ReviewerTable reviewers={data.reviewers} />

      <h3 className="team-section-header">Stale PRs</h3>
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
      <div className="repo-picker">
        <label htmlFor="team-repo" className="repo-picker-label">Repository</label>
        <select
          id="team-repo"
          className="repo-picker-select"
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

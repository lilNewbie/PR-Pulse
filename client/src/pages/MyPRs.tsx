// Owned by Mandaar
import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import type { Flags, MyPrsResponse, PrSummary } from 'shared'
import { apiFetch, ApiClientError } from '../api/client'
import WaitingOn from '../components/WaitingOn'

type State =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'ok'; items: PrSummary[] }
  | { status: 'error'; message: string }

type Tone = 'warn' | 'danger' | 'muted' | 'info'

const TONE_CLASS: Record<Tone, string> = {
  warn:   'badge badge-warn',
  danger: 'badge badge-danger',
  muted:  'badge badge-muted',
  info:   'badge badge-info',
}

function Badge({ tone, children }: { tone: Tone; children: string }) {
  return <span className={TONE_CLASS[tone]}>{children}</span>
}

function sizeLabel(lines: number): string {
  if (lines >= 500) return `XL · ${lines} lines`
  if (lines >= 200) return `L · ${lines} lines`
  if (lines >= 50)  return `M · ${lines} lines`
  return `S · ${lines} lines`
}

function sizeTone(lines: number): Tone {
  if (lines >= 500) return 'danger'
  if (lines >= 200) return 'warn'
  return 'muted'
}

// The badges for one PR, in the order: draft, stale, conflict, behind, size (US-08, US-09).
export function flagBadges(flags: Flags, isDraft: boolean, linesChanged: number): { tone: Tone; label: string }[] {
  const badges: { tone: Tone; label: string }[] = []
  if (isDraft) badges.push({ tone: 'muted', label: 'Draft' })
  if (flags.stale) badges.push({ tone: 'warn', label: `Stale · ${flags.inactiveHours}h inactive` })
  if (flags.conflict === 'yes') badges.push({ tone: 'danger', label: 'Merge conflict' })
  if (flags.conflict === 'checking') badges.push({ tone: 'muted', label: 'Checking…' })
  if (flags.behindBy > 0) badges.push({ tone: 'warn', label: `Behind main by ${flags.behindBy}` })
  badges.push({ tone: sizeTone(linesChanged), label: sizeLabel(linesChanged) })
  return badges
}

function PrRow({ pr }: { pr: PrSummary }) {
  const badges = flagBadges(pr.flags, pr.isDraft, pr.linesChanged)
  return (
    <li className="pr-item">
      <div className="pr-title">
        <a href={pr.url} target="_blank" rel="noreferrer">{pr.title}</a>
        <span className="pr-external-icon" aria-hidden>↗</span>
      </div>
      <div className="pr-meta">
        {pr.repo} #{pr.number}
      </div>
      <div className="pr-badges">
        {badges.map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}
      </div>
      {/* US-21: who this PR is waiting on (Alan's component; drafts render nothing). */}
      <WaitingOn pr={pr} />
    </li>
  )
}

export default function MyPRs() {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    apiFetch<MyPrsResponse>('/api/my-prs')
      .then((res) => setState({ status: 'ok', items: res.items }))
      .catch((err: unknown) => {
        if (err instanceof ApiClientError && err.status === 401) setState({ status: 'unauthenticated' })
        else setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong' })
      })
  }, [])

  if (state.status === 'loading') return <p className="text-muted">Loading…</p>
  if (state.status === 'unauthenticated') return <Navigate to="/signin" replace />
  if (state.status === 'error') return <p className="text-error">Couldn't load your PRs: {state.message}</p>

  return (
    <section>
      <h2 className="page-title">My PRs</h2>
      {state.items.length === 0 ? (
        <p className="text-muted">You have no open pull requests.</p>
      ) : (
        <ul className="pr-list">
          {state.items.map((pr) => <PrRow key={pr.id} pr={pr} />)}
        </ul>
      )}
    </section>
  )
}

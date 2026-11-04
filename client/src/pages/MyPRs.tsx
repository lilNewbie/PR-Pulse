// Owned by Mandaar
import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import type { Flags, MyPrsResponse, PrSummary } from 'shared'
import { apiFetch, ApiClientError } from '../api/client'

type State =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'ok'; items: PrSummary[] }
  | { status: 'error'; message: string }

type Tone = 'warn' | 'danger' | 'muted'

const TONES: Record<Tone, { background: string; color: string }> = {
  warn: { background: '#fff4d6', color: '#7a5200' },
  danger: { background: '#fde2e1', color: '#9b1c1c' },
  muted: { background: '#eceef1', color: '#3d4450' },
}

function Badge({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span
      style={{
        ...TONES[tone],
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

// The badges for one PR, in the order: stale, conflict, behind (US-08, US-09).
export function flagBadges(flags: Flags): { tone: Tone; label: string }[] {
  const badges: { tone: Tone; label: string }[] = []
  if (flags.stale) badges.push({ tone: 'warn', label: `Stale · ${flags.inactiveHours}h inactive` })
  if (flags.conflict === 'yes') badges.push({ tone: 'danger', label: 'Merge conflict' })
  if (flags.conflict === 'checking') badges.push({ tone: 'muted', label: 'Checking…' })
  if (flags.behindBy > 0) badges.push({ tone: 'warn', label: `Behind main by ${flags.behindBy}` })
  return badges
}

function PrRow({ pr }: { pr: PrSummary }) {
  const badges = flagBadges(pr.flags)
  return (
    <li style={{ padding: '12px 0', borderBottom: '1px solid #e5e7eb' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <a href={pr.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
          {pr.title}
        </a>
        <span style={{ color: '#6b7280', fontSize: 13 }}>
          {pr.repo} #{pr.number}
          {pr.isDraft ? ' · Draft' : ''} · {pr.linesChanged} lines
        </span>
      </div>
      {badges.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {badges.map((b) => (
            <Badge key={b.label} tone={b.tone}>
              {b.label}
            </Badge>
          ))}
        </div>
      )}
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

  if (state.status === 'loading') return <p>Loading…</p>
  if (state.status === 'unauthenticated') return <Navigate to="/signin" replace />
  if (state.status === 'error') return <p>Couldn't load your PRs: {state.message}</p>

  return (
    <section>
      <h1 style={{ fontSize: 20 }}>My PRs</h1>
      {state.items.length === 0 ? (
        <p>You have no open pull requests.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {state.items.map((pr) => (
            <PrRow key={pr.id} pr={pr} />
          ))}
        </ul>
      )}
    </section>
  )
}

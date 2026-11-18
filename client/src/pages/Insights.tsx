// Insights dashboard: KPI tiles and charts built from existing read-only endpoints.
// GET /api/my-prs (any role), GET /api/queue (Reviewer, Lead), GET /api/deployments (Lead),
// GET /api/team/bottlenecks (Lead). Nothing here writes data or calls a new endpoint.
import { useEffect, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { BottleneckResponse, DeploymentSummary, MyPrsResponse, PrSummary, QueueItem, QueueResponse, Role } from 'shared'
import { apiFetch } from '../api/client'
import { useMe } from '../hooks/useMe'
import {
  computeKpis,
  deploysPerDay,
  flagCounts,
  inRepo,
  reviewerLoadBars,
  waitBuckets,
  type CountRow,
  type DeployDay,
  type Kpis,
  type ReviewerBar,
} from './insightsData'
import './Insights.css'

const SERIES  = '#3987e5'
const FAILED  = '#d03b3b'
const OVERLOAD = '#e06c3a'
const PENDING = '#6e7681'
const GRID    = '#30363d'
const MUTED   = '#8b949e'
const SURFACE = '#161b22'

const DEPLOY_SERIES = [
  { key: 'success', label: '✓ Succeeded', color: SERIES },
  { key: 'failed',  label: '✕ Failed',    color: FAILED  },
  { key: 'pending', label: '… Pending',   color: PENDING },
] as const

// ── KPI card ────────────────────────────────────────────────────────────────

function KpiCard({
  icon, iconBg, label, value, note,
}: {
  icon: string; iconBg: string; label: string; value: string; note?: string
}) {
  return (
    <div className="dash-kpi">
      <div className="dash-kpi-icon" style={{ background: iconBg }}>
        {icon}
      </div>
      <div className="dash-kpi-body">
        <div className="dash-kpi-label">{label}</div>
        <div className="dash-kpi-value">{value}</div>
        {note && <div className="dash-kpi-note">{note}</div>}
      </div>
    </div>
  )
}

// ── Chart card wrapper ───────────────────────────────────────────────────────

function ChartCard({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <section className="insights-card" aria-label={title}>
      <h3>{title}</h3>
      <p className="insights-card-sub">{sub}</p>
      {children}
    </section>
  )
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

function TooltipBox({ active, label, lines }: { active?: boolean; label?: string; lines: string[] }) {
  if (!active) return null
  return (
    <div className="insights-tooltip">
      <strong>{label}</strong>
      {lines.map((line) => <div key={line}>{line}</div>)}
    </div>
  )
}

// ── Vertical bar chart (wait buckets, flag counts) ────────────────────────────

function CountChart({ rows, unit }: { rows: CountRow[]; unit: string }) {
  return (
    <>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: 'rgba(139,148,158,0.12)' }}
              content={({ active, payload, label }) => (
                <TooltipBox
                  active={active}
                  label={String(label)}
                  lines={payload?.length ? [`${payload[0].value} ${unit}`] : []}
                />
              )}
            />
            <Bar dataKey="count" fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details>
        <summary>Show as table</summary>
        <table>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  )
}

// ── Deployment stacked bar chart ──────────────────────────────────────────────

function DeployChart({ days }: { days: DeployDay[] }) {
  return (
    <>
      <div className="insights-legend">
        {DEPLOY_SERIES.map((s) => (
          <span key={s.key}>
            <span className="insights-legend-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <BarChart data={days} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis
              dataKey="label"
              tick={{ fill: MUTED, fontSize: 12 }}
              axisLine={{ stroke: GRID }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis allowDecimals={false} tick={{ fill: MUTED, fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: 'rgba(139,148,158,0.12)' }}
              content={({ active, label, payload }) => {
                const day = payload?.[0]?.payload as DeployDay | undefined
                return (
                  <TooltipBox
                    active={active}
                    label={String(label)}
                    lines={day ? DEPLOY_SERIES.map((s) => `${s.label}: ${day[s.key]}`) : []}
                  />
                )
              }}
            />
            {DEPLOY_SERIES.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="deploys"
                fill={s.color}
                stroke={SURFACE}
                strokeWidth={2}
                maxBarSize={28}
                radius={i === DEPLOY_SERIES.length - 1 ? [4, 4, 0, 0] : 0}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details>
        <summary>Show as table</summary>
        <table>
          <thead>
            <tr>
              <th>Day</th>
              {DEPLOY_SERIES.map((s) => <th key={s.key}>{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <th scope="row">{day.label}</th>
                <td>{day.success}</td>
                <td>{day.failed}</td>
                <td>{day.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  )
}

// ── Horizontal bar chart (reviewer load) ─────────────────────────────────────

function ReviewerLoadChart({ bars }: { bars: ReviewerBar[] }) {
  if (bars.length === 0) return <p className="text-muted" style={{ padding: '1rem 0' }}>No reviewers found</p>
  const height = Math.max(180, bars.length * 38 + 48)
  return (
    <>
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <BarChart layout="vertical" data={bars} margin={{ top: 4, right: 48, bottom: 4, left: 0 }}>
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis
              type="number"
              allowDecimals={false}
              tick={{ fill: MUTED, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="login"
              width={96}
              tick={{ fill: MUTED, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: 'rgba(139,148,158,0.12)' }}
              content={({ active, payload, label }) => {
                const bar = payload?.[0]?.payload as ReviewerBar | undefined
                return (
                  <TooltipBox
                    active={active}
                    label={String(label)}
                    lines={bar ? [`${bar.openRequests} open request${bar.openRequests !== 1 ? 's' : ''}${bar.overloaded ? ' · overloaded' : ''}`] : []}
                  />
                )
              }}
            />
            <Bar dataKey="openRequests" radius={[0, 4, 4, 0]} maxBarSize={22} label={{ position: 'right', fill: MUTED, fontSize: 12 }}>
              {bars.map((r) => (
                <Cell key={r.login} fill={r.overloaded ? OVERLOAD : SERIES} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="insights-legend" style={{ marginTop: '0.5rem' }}>
        <span><span className="insights-legend-swatch" style={{ background: SERIES }} />Normal</span>
        <span><span className="insights-legend-swatch" style={{ background: OVERLOAD }} />Overloaded (≥4)</span>
      </div>
    </>
  )
}

// ── Recent stale PRs table ────────────────────────────────────────────────────

type StalePr = BottleneckResponse['stalePrs'][number]

function RecentStalePrs({ prs }: { prs: StalePr[] }) {
  if (prs.length === 0) {
    return <p className="text-muted" style={{ padding: '0.5rem 0' }}>No stale PRs — nice work.</p>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="queue-table">
        <thead>
          <tr>
            <th>PR</th>
            <th>Title</th>
            <th>Repo</th>
            <th>Author</th>
            <th>Inactive</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {prs.map((pr) => (
            <tr key={pr.id}>
              <td className="queue-mono">
                <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a>
              </td>
              <td style={{ maxWidth: 280 }}>{pr.title}</td>
              <td className="queue-mono" style={{ fontSize: 11 }}>{pr.repo}</td>
              <td className="queue-mono">{pr.authorLogin}</td>
              <td className="queue-mono">{pr.inactiveHours}h</td>
              <td>
                <div className="pr-badges" style={{ margin: 0 }}>
                  <span className="badge badge-warn">Stale</span>
                  {pr.flags.conflict === 'yes' && <span className="badge badge-danger">Conflict</span>}
                  {pr.flags.behindBy > 0 && <span className="badge badge-muted">{pr.flags.behindBy} behind</span>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Totals row (Lead-only) ────────────────────────────────────────────────────

function TotalsRow({ totals }: { totals: BottleneckResponse['totals'] }) {
  const overloaded = 0 // computed from reviewers; shown in KPI cards instead
  void overloaded
  return (
    <div className="dash-totals">
      <span>Open PRs: <strong>{totals.openPrs}</strong></span>
      <span>Open requests: <strong>{totals.openRequests}</strong></span>
      <span>Stale: <strong>{totals.stalePrs}</strong></span>
    </div>
  )
}

// ── InsightsView ─────────────────────────────────────────────────────────────

export interface InsightsData {
  queue: QueueItem[] | null
  myPrs: PrSummary[] | null
  deployDays: DeployDay[] | null
  bottlenecks: BottleneckResponse | null
  warnings: string[]
}

/** Presentational, exported for component tests. */
export function InsightsView({ data }: { data: InsightsData }) {
  const kpis: Kpis = computeKpis(data)
  const { bottlenecks } = data

  const reviewerBars = bottlenecks ? reviewerLoadBars(bottlenecks.reviewers) : null
  const overloadedCount = bottlenecks
    ? bottlenecks.reviewers.filter((r) => r.overloaded).length
    : null

  return (
    <>
      {data.warnings.length > 0 && (
        <ul className="insights-warnings" role="status">
          {data.warnings.map((warning) => <li key={warning}>⚠ {warning}</li>)}
        </ul>
      )}

      {/* ── KPI row ── */}
      <div className="dash-kpi-row">
        {bottlenecks && (
          <KpiCard
            icon="⬡"
            iconBg="rgba(57,135,229,0.18)"
            label="Open PRs"
            value={String(bottlenecks.totals.openPrs)}
            note={`${bottlenecks.totals.openRequests} open requests`}
          />
        )}
        {kpis.waitingOnMe !== null && (
          <KpiCard
            icon="⏳"
            iconBg="rgba(210,153,34,0.18)"
            label="Waiting on my review"
            value={String(kpis.waitingOnMe)}
            note={kpis.longestWaitHours !== null ? `Longest: ${kpis.longestWaitHours}h` : undefined}
          />
        )}
        {(kpis.myStalePrs !== null || bottlenecks) && (
          <KpiCard
            icon="⚠"
            iconBg="rgba(248,81,73,0.18)"
            label="Stale PRs"
            value={String(bottlenecks ? bottlenecks.totals.stalePrs : (kpis.myStalePrs ?? '—'))}
            note={bottlenecks ? 'across your repos' : 'in my open PRs'}
          />
        )}
        {overloadedCount !== null && (
          <KpiCard
            icon="⚡"
            iconBg="rgba(224,108,58,0.18)"
            label="Overloaded reviewers"
            value={String(overloadedCount)}
            note="≥4 open requests"
          />
        )}
        {overloadedCount === null && kpis.releaseBlockers !== null && (
          <KpiCard
            icon="🔒"
            iconBg="rgba(248,81,73,0.18)"
            label="Release blockers"
            value={String(kpis.releaseBlockers)}
            note="in my review queue"
          />
        )}
        {kpis.deploys !== null && (
          <KpiCard
            icon="🚀"
            iconBg="rgba(63,185,80,0.18)"
            label="Deploys (14 days)"
            value={String(kpis.deploys)}
            note={kpis.failedDeploys ? `${kpis.failedDeploys} failed` : 'all succeeded'}
          />
        )}
      </div>

      {/* ── Charts row ── */}
      <div className="dash-charts-row">
        {data.deployDays !== null && (
          <ChartCard title="Deploy activity" sub="Last 14 days (UTC), by status">
            <DeployChart days={data.deployDays} />
          </ChartCard>
        )}
        {reviewerBars !== null && (
          <ChartCard
            title="Reviewer load"
            sub="Open review requests per team member"
          >
            <ReviewerLoadChart bars={reviewerBars} />
          </ChartCard>
        )}
        {data.queue !== null && (
          <ChartCard title="Queue by wait time" sub="PRs waiting on my review, by hours since the request">
            <CountChart rows={waitBuckets(data.queue)} unit="PRs" />
          </ChartCard>
        )}
        {data.myPrs !== null && (
          <ChartCard title="My open PRs by flag" sub="A PR with several flags counts once in each">
            <CountChart rows={flagCounts(data.myPrs)} unit="open PRs" />
          </ChartCard>
        )}
      </div>

      {/* ── Recent stale PRs (Lead only) ── */}
      {bottlenecks && (
        <section className="insights-card" style={{ marginTop: '0.75rem' }}>
          <div className="dash-section-header">
            <h3>Stale pull requests</h3>
            <TotalsRow totals={bottlenecks.totals} />
          </div>
          <p className="insights-card-sub">Open, non-draft PRs with no activity for 24+ hours</p>
          <RecentStalePrs prs={bottlenecks.stalePrs} />
        </section>
      )}
    </>
  )
}

// ── Data loading ──────────────────────────────────────────────────────────────

type Settled<T> = { ok: true; value: T } | { ok: false; message: string }

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : 'request failed' }),
  )
}

type Repo = { id: number; fullName: string }

export async function loadInsights(role: Role, repos: Repo[], repoName: string | null, now: Date): Promise<InsightsData> {
  const repoId = repoName === null ? null : repos.find((r) => r.fullName === repoName)?.id ?? null

  const [myPrs, queue, deployments, bottlenecks] = await Promise.all([
    settle(apiFetch<MyPrsResponse>('/api/my-prs').then((r) => r.items)),
    role === 'pr_author' ? null : settle(apiFetch<QueueResponse>('/api/queue').then((r) => r.items)),
    role === 'lead'
      ? Promise.all(
          repos.map(async (repo) => ({
            repo,
            result: await settle(apiFetch<DeploymentSummary[]>(`/api/deployments?repoId=${repo.id}`)),
          })),
        )
      : null,
    role === 'lead'
      ? settle(apiFetch<BottleneckResponse>(repoId ? `/api/team/bottlenecks?repoId=${repoId}` : '/api/team/bottlenecks'))
      : null,
  ])

  const warnings: string[] = []
  if (!myPrs.ok) warnings.push(`My PRs couldn't be loaded: ${myPrs.message}`)
  if (queue && !queue.ok) warnings.push(`Your review queue couldn't be loaded: ${queue.message}`)
  if (bottlenecks && !bottlenecks.ok) warnings.push(`Team bottlenecks couldn't be loaded: ${bottlenecks.message}`)

  let deployDays: DeployDay[] | null = null
  if (deployments) {
    const loaded: DeploymentSummary[] = []
    for (const { repo, result } of deployments) {
      if (result.ok) loaded.push(...result.value)
      else warnings.push(`Deployments for ${repo.fullName} couldn't be loaded: ${result.message}`)
    }
    const anyLoaded = deployments.length === 0 || deployments.some((d) => d.result.ok)
    deployDays = anyLoaded ? deploysPerDay(loaded, now) : null
  }

  return {
    myPrs: myPrs.ok ? inRepo(myPrs.value, repoName) : null,
    queue: queue && queue.ok ? inRepo(queue.value, repoName) : null,
    deployDays,
    bottlenecks: bottlenecks && bottlenecks.ok ? bottlenecks.value : null,
    warnings,
  }
}

// ── Page component ────────────────────────────────────────────────────────────

type LoadState = { status: 'loading' } | { status: 'loaded'; data: InsightsData }

export default function Insights() {
  const me = useMe()
  const [repoId, setRepoId] = useState<number | null>(null)
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const role = me.status === 'ok' ? me.me.role : null
  const repos = me.status === 'ok' ? me.me.repos : null

  useEffect(() => {
    if (role === null || repos === null) return
    let cancelled = false
    setState({ status: 'loading' })
    const picked = repoId === null ? repos : repos.filter((r) => r.id === repoId)
    const repoName = repoId === null ? null : (picked[0]?.fullName ?? null)
    loadInsights(role, picked, repoName, new Date()).then((data) => {
      if (!cancelled) setState({ status: 'loaded', data })
    })
    return () => { cancelled = true }
  }, [role, repoId, repos])

  if (me.status === 'loading') return <p className="text-muted">Loading…</p>
  if (me.status === 'unauthenticated') return <Navigate to="/signin" replace />
  if (me.status === 'error') return <p className="text-error">Error: {me.message}</p>

  return (
    <section className="insights">
      <div className="dash-header">
        <h2 className="page-title" style={{ marginBottom: 0 }}>Insights</h2>
        <div className="insights-filters">
          <label htmlFor="insights-repo">Repository</label>
          <select
            id="insights-repo"
            value={repoId ?? ''}
            onChange={(e) => setRepoId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">All repositories</option>
            {(repos ?? []).map((repo) => (
              <option key={repo.id} value={repo.id}>{repo.fullName}</option>
            ))}
          </select>
        </div>
      </div>
      {state.status === 'loaded'
        ? <InsightsView data={state.data} />
        : <p className="text-muted">Loading insights…</p>}
    </section>
  )
}

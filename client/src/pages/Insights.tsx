// Insights dashboard: KPI tiles and charts built from existing read-only endpoints.
// GET /api/my-prs (any role), GET /api/queue (Reviewer, Lead), GET /api/deployments (Lead).
// Nothing here writes data or calls a new endpoint.
import { useEffect, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { DeploymentSummary, MyPrsResponse, PrSummary, QueueItem, QueueResponse, Role } from 'shared'
import { apiFetch } from '../api/client'
import { useMe } from '../hooks/useMe'
import {
  computeKpis,
  deploysPerDay,
  flagCounts,
  inRepo,
  waitBuckets,
  type CountRow,
  type DeployDay,
  type Kpis,
} from './insightsData'
import './Insights.css'

// The app is dark-themed only. Validated on the chart surface #161b22 (dataviz validator: all checks pass).
const SERIES = '#3987e5' // blue: single-series bars and "Succeeded"
const FAILED = '#d03b3b' // status critical, always paired with the "✕ Failed" label
const PENDING = '#6e7681' // neutral gray
const GRID = '#30363d'
const MUTED = '#8b949e'
const SURFACE = '#161b22'

const DEPLOY_SERIES = [
  { key: 'success', label: '✓ Succeeded', color: SERIES },
  { key: 'failed', label: '✕ Failed', color: FAILED },
  { key: 'pending', label: '… Pending', color: PENDING },
] as const

function KpiTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="insights-kpi">
      <div className="insights-kpi-label">{label}</div>
      <div className="insights-kpi-value">{value}</div>
      {note && <div className="insights-kpi-note">{note}</div>}
    </div>
  )
}

function ChartCard({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <section className="insights-card" aria-label={title}>
      <h3>{title}</h3>
      <p className="insights-card-sub">{sub}</p>
      {children}
    </section>
  )
}

function TooltipBox({ active, label, lines }: { active?: boolean; label?: string; lines: string[] }) {
  if (!active) return null
  return (
    <div className="insights-tooltip">
      <strong>{label}</strong>
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  )
}

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
              cursor={{ fill: 'rgba(139, 148, 158, 0.12)' }}
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
              cursor={{ fill: 'rgba(139, 148, 158, 0.12)' }}
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
              {DEPLOY_SERIES.map((s) => (
                <th key={s.key}>{s.label}</th>
              ))}
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

export interface InsightsData {
  queue: QueueItem[] | null // null: not a Reviewer or Lead, or it failed to load (see warnings)
  myPrs: PrSummary[] | null // null: it failed to load (see warnings)
  deployDays: DeployDay[] | null // null: not a Lead, or no repo's deployments loaded (see warnings)
  warnings: string[] // one line per source that failed; the rest of the dashboard still renders
}

/** Presentational, exported for component tests. */
export function InsightsView({ data }: { data: InsightsData }) {
  const kpis: Kpis = computeKpis(data)

  return (
    <>
      {data.warnings.length > 0 && (
        <ul className="insights-warnings" role="status">
          {data.warnings.map((warning) => (
            <li key={warning}>⚠ {warning}</li>
          ))}
        </ul>
      )}

      <div className="insights-kpis">
        {kpis.waitingOnMe !== null && <KpiTile label="Waiting on my review" value={String(kpis.waitingOnMe)} />}
        {kpis.waitingOnMe !== null && (
          <KpiTile label="Longest wait" value={kpis.longestWaitHours === null ? '—' : `${kpis.longestWaitHours}h`} />
        )}
        {kpis.releaseBlockers !== null && <KpiTile label="Release blockers in my queue" value={String(kpis.releaseBlockers)} />}
        {kpis.myOpenPrs !== null && <KpiTile label="My open PRs" value={String(kpis.myOpenPrs)} />}
        {kpis.myStalePrs !== null && <KpiTile label="My stale PRs" value={String(kpis.myStalePrs)} />}
        {kpis.deploys !== null && (
          <KpiTile label="Deploys, last 14 days" value={String(kpis.deploys)} note={`${kpis.failedDeploys} failed`} />
        )}
      </div>

      <div className="insights-grid">
        {data.queue !== null && (
          <ChartCard title="Review queue by wait time" sub="PRs waiting on my review, by hours since the request">
            <CountChart rows={waitBuckets(data.queue)} unit="PRs" />
          </ChartCard>
        )}
        {data.myPrs !== null && (
          <ChartCard title="My open PRs by flag" sub="A PR with several flags counts once in each">
            <CountChart rows={flagCounts(data.myPrs)} unit="open PRs" />
          </ChartCard>
        )}
        {data.deployDays !== null && (
          <ChartCard title="Deployments per day" sub="Last 14 days (UTC), by status">
            <DeployChart days={data.deployDays} />
          </ChartCard>
        )}
      </div>
    </>
  )
}

type Settled<T> = { ok: true; value: T } | { ok: false; message: string }

// Never rejects, so one failed request can't take the other panels down with it.
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : 'request failed' }),
  )
}

type Repo = { id: number; fullName: string }

/** Loads each source independently. A failed source becomes a warning instead of an error page. */
export async function loadInsights(role: Role, repos: Repo[], repoName: string | null, now: Date): Promise<InsightsData> {
  const [myPrs, queue, deployments] = await Promise.all([
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
  ])

  const warnings: string[] = []
  if (!myPrs.ok) warnings.push(`My PRs couldn't be loaded: ${myPrs.message}`)
  if (queue && !queue.ok) warnings.push(`Your review queue couldn't be loaded: ${queue.message}`)

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
    warnings,
  }
}

type LoadState = { status: 'loading' } | { status: 'loaded'; data: InsightsData }

export default function Insights() {
  const me = useMe()
  const [repoId, setRepoId] = useState<number | null>(null)
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const role = me.status === 'ok' ? me.me.role : null
  // Stable between renders: it comes from useMe's state object.
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
    return () => {
      cancelled = true
    }
  }, [role, repoId, repos])

  if (me.status === 'loading') return <p className="text-muted">Loading…</p>
  if (me.status === 'unauthenticated') return <Navigate to="/signin" replace />
  if (me.status === 'error') return <p className="text-error">Error: {me.message}</p>

  return (
    <section className="insights">
      <h2 className="page-title">Insights</h2>
      <div className="insights-filters">
        <label htmlFor="insights-repo">Repository</label>
        <select
          id="insights-repo"
          value={repoId ?? ''}
          onChange={(event) => setRepoId(event.target.value === '' ? null : Number(event.target.value))}
        >
          <option value="">All repositories</option>
          {(repos ?? []).map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.fullName}
            </option>
          ))}
        </select>
      </div>
      {state.status === 'loaded' ? <InsightsView data={state.data} /> : <p className="text-muted">Loading insights…</p>}
    </section>
  )
}

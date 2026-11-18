// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { DeploymentSummary, Me, PrSummary, QueueItem, Role } from 'shared'
import Insights, { InsightsView } from '../client/src/pages/Insights'
import { computeKpis, deploysPerDay, flagCounts, inRepo, waitBuckets } from '../client/src/pages/insightsData'
import { useMe } from '../client/src/hooks/useMe'

vi.mock('../client/src/hooks/useMe', () => ({ useMe: vi.fn() }))

// Recharts' ResponsiveContainer needs ResizeObserver, which jsdom doesn't have.
// Assigned at module level so it survives vi.unstubAllGlobals() between tests.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver

const NOW = new Date('2026-11-18T12:00:00Z')

function pr(id: number, over: Partial<PrSummary> = {}, flags: Partial<PrSummary['flags']> = {}): PrSummary {
  return {
    id,
    repo: 'acme/api',
    number: id,
    title: `PR ${id}`,
    url: `https://github.com/acme/api/pull/${id}`,
    authorLogin: 'me',
    state: 'open',
    isDraft: false,
    linesChanged: 10,
    flags: { stale: false, inactiveHours: 1, conflict: 'no', behindBy: 0, ...flags },
    ...over,
  }
}

function queued(id: number, waitingHours: number, over: Partial<QueueItem> = {}): QueueItem {
  return { ...pr(id), waitingHours, position: id, isReleaseBlocker: false, ...over }
}

function deploy(id: number, createdAt: string, status: DeploymentSummary['status']): DeploymentSummary {
  return { id, sha: 'a'.repeat(40), environment: 'staging', status, source: 'webhook', createdAt, prCount: 0 }
}

describe('Insights data', () => {
  it('buckets the review queue by wait time, keeping empty buckets', () => {
    const rows = waitBuckets([queued(1, 0), queued(2, 3.9), queued(3, 4), queued(4, 30), queued(5, 72), queued(6, 200)])
    expect(rows).toEqual([
      { label: '< 4h', count: 2 },
      { label: '4–24h', count: 1 },
      { label: '1–3 days', count: 1 },
      { label: '3+ days', count: 2 },
    ])
    expect(waitBuckets([]).map((r) => r.count)).toEqual([0, 0, 0, 0])
  })

  it('counts open PRs per flag; closed and merged PRs are ignored', () => {
    const rows = flagCounts([
      pr(1, {}, { stale: true, conflict: 'yes' }),
      pr(2, {}, { behindBy: 3 }),
      pr(3, { isDraft: true }),
      pr(4, { state: 'merged' }, { stale: true }),
      pr(5, {}, { conflict: 'checking' }),
    ])
    expect(rows).toEqual([
      { label: 'Stale', count: 1 },
      { label: 'Merge conflict', count: 1 },
      { label: 'Behind main', count: 1 },
      { label: 'Draft', count: 1 },
    ])
  })

  it('counts deployments per UTC day for the last 14 days by status', () => {
    const days = deploysPerDay(
      [
        deploy(1, '2026-11-18T01:00:00Z', 'success'),
        deploy(2, '2026-11-18T09:00:00Z', 'failed'),
        deploy(3, '2026-11-05T23:59:00Z', 'pending'),
        deploy(4, '2026-11-04T23:59:00Z', 'success'), // 15 days ago: outside the window
      ],
      NOW,
    )
    expect(days).toHaveLength(14)
    expect(days[0]).toMatchObject({ date: '2026-11-05', label: 'Nov 5', success: 0, failed: 0, pending: 1 })
    expect(days[13]).toMatchObject({ date: '2026-11-18', success: 1, failed: 1, pending: 0 })
    expect(days.reduce((n, d) => n + d.success + d.failed + d.pending, 0)).toBe(3)
  })

  it('computes the KPIs, with null for data the role cannot see', () => {
    expect(
      computeKpis({
        queue: [queued(1, 5), queued(2, 40, { isReleaseBlocker: true })],
        myPrs: [pr(3, {}, { stale: true }), pr(4), pr(5, { state: 'closed' })],
        deployDays: deploysPerDay([deploy(1, '2026-11-18T01:00:00Z', 'failed')], NOW),
      }),
    ).toEqual({
      waitingOnMe: 2,
      longestWaitHours: 40,
      releaseBlockers: 1,
      myOpenPrs: 2,
      myStalePrs: 1,
      deploys: 1,
      failedDeploys: 1,
    })
    expect(computeKpis({ queue: null, myPrs: [], deployDays: null })).toMatchObject({
      waitingOnMe: null,
      longestWaitHours: null,
      deploys: null,
    })
    expect(computeKpis({ queue: [], myPrs: [], deployDays: null }).longestWaitHours).toBeNull()
    expect(computeKpis({ queue: null, myPrs: null, deployDays: null })).toMatchObject({ myOpenPrs: null, myStalePrs: null })
  })

  it('filters PRs to one repository', () => {
    const prs = [pr(1), pr(2, { repo: 'acme/web' })]
    expect(inRepo(prs, null)).toHaveLength(2)
    expect(inRepo(prs, 'acme/web').map((p) => p.id)).toEqual([2])
  })
})

describe('Insights page', () => {
  const fetchMock = vi.fn()

  function signedInAs(role: Role) {
    const me: Me = { id: 1, login: 'me', role, repos: [{ id: 7, fullName: 'acme/api' }, { id: 8, fullName: 'acme/web' }] }
    vi.mocked(useMe).mockReturnValue({ status: 'ok', me })
  }

  function respond(routes: Record<string, unknown>) {
    fetchMock.mockImplementation(async (url: string) => {
      if (!(url in routes)) return { ok: false, status: 403, statusText: '403', json: async () => ({ error: 'nope' }) }
      return { ok: true, status: 200, statusText: '200', json: async () => routes[url] }
    })
  }

  const calledUrls = () => fetchMock.mock.calls.map((call) => call[0] as string)

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders KPI tiles and a table view for each chart', () => {
    render(
      <InsightsView
        data={{
          queue: [queued(1, 5), queued(2, 80, { isReleaseBlocker: true })],
          myPrs: [pr(3, {}, { stale: true })],
          deployDays: deploysPerDay([deploy(1, '2026-11-18T01:00:00Z', 'failed')], NOW),
          bottlenecks: null,
          warnings: [],
        }}
      />,
    )

    const tile = (label: string) => screen.getByText(label).parentElement!.textContent
    expect(tile('Waiting on my review')).toContain('2')
    expect(tile('Longest wait')).toContain('80h')
    expect(tile('Release blockers in my queue')).toContain('1')
    expect(tile('My stale PRs')).toContain('1')
    expect(tile('Deploys, last 14 days')).toContain('1 failed')

    const queueCard = screen.getByRole('region', { name: 'Review queue by wait time' })
    expect(within(queueCard).getByRole('row', { name: '3+ days 1' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Deployments per day' }).textContent).toContain('✕ Failed')
  })

  it('PR Author: only My PRs is fetched; no queue or deployment panels', async () => {
    signedInAs('pr_author')
    respond({ '/api/my-prs': { items: [pr(1)] } })
    render(<MemoryRouter><Insights /></MemoryRouter>)

    await screen.findByRole('region', { name: 'My open PRs by flag' })
    expect(calledUrls()).toEqual(['/api/my-prs'])
    expect(screen.queryByRole('region', { name: 'Review queue by wait time' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Deployments per day' })).toBeNull()
  })

  it('Lead: fetches deployments for every repo, then only the picked repo', async () => {
    signedInAs('lead')
    respond({
      '/api/my-prs': { items: [pr(1), pr(2, { repo: 'acme/web' })] },
      '/api/queue': { items: [], lastSyncedAt: null, syncWarning: false },
      '/api/deployments?repoId=7': [],
      '/api/deployments?repoId=8': [],
    })
    render(<MemoryRouter><Insights /></MemoryRouter>)

    await screen.findByRole('region', { name: 'Deployments per day' })
    expect(calledUrls()).toEqual(
      expect.arrayContaining(['/api/my-prs', '/api/queue', '/api/deployments?repoId=7', '/api/deployments?repoId=8']),
    )
    expect(screen.getByText('My open PRs').parentElement!.textContent).toContain('2')

    fetchMock.mockClear()
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: '8' } })
    await waitFor(() => expect(calledUrls()).toContain('/api/deployments?repoId=8'))
    expect(calledUrls()).not.toContain('/api/deployments?repoId=7')
    await waitFor(() => expect(screen.getByText('My open PRs').parentElement!.textContent).toContain('1'))
  })

  it('a failed review queue becomes a warning; My PRs still renders', async () => {
    signedInAs('reviewer')
    respond({ '/api/my-prs': { items: [pr(1, {}, { stale: true })] } }) // /api/queue answers 403 "nope"
    render(<MemoryRouter><Insights /></MemoryRouter>)

    expect((await screen.findByRole('status')).textContent).toContain("Your review queue couldn't be loaded: nope")
    expect(screen.getByRole('region', { name: 'My open PRs by flag' })).toBeTruthy()
    expect(screen.getByText('My stale PRs').parentElement!.textContent).toContain('1')
    expect(screen.queryByText('Waiting on my review')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Review queue by wait time' })).toBeNull()
  })

  it("Lead: one repo's deployments failing keeps the rest of the dashboard and the other repo's deploys", async () => {
    signedInAs('lead')
    const today = new Date().toISOString()
    respond({
      '/api/my-prs': { items: [pr(1)] },
      '/api/queue': { items: [queued(2, 10)], lastSyncedAt: null, syncWarning: false },
      '/api/deployments?repoId=7': [deploy(1, today, 'success'), deploy(2, today, 'failed')],
      // repoId=8 answers 403 "nope"
    })
    render(<MemoryRouter><Insights /></MemoryRouter>)

    expect((await screen.findByRole('status')).textContent).toContain(
      "Deployments for acme/web couldn't be loaded: nope",
    )
    expect(screen.getByText('Deploys, last 14 days').parentElement!.textContent).toContain('2')
    expect(screen.getByText('Waiting on my review').parentElement!.textContent).toContain('1')
    expect(screen.getByText('My open PRs').parentElement!.textContent).toContain('1')
    expect(screen.getByRole('region', { name: 'Deployments per day' })).toBeTruthy()
  })

  it('Lead: when every deployment request fails, only the deployment panel is hidden', async () => {
    signedInAs('lead')
    respond({
      '/api/my-prs': { items: [] },
      '/api/queue': { items: [], lastSyncedAt: null, syncWarning: false },
      '/api/team/bottlenecks': { reviewers: [], stalePrs: [], totals: { openPrs: 0, openRequests: 0, stalePrs: 0 } },
    })
    render(<MemoryRouter><Insights /></MemoryRouter>)

    const warnings = await screen.findByRole('status')
    expect(within(warnings).getAllByRole('listitem')).toHaveLength(2) // acme/api and acme/web
    expect(screen.queryByRole('region', { name: 'Deployments per day' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Review queue by wait time' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'My open PRs by flag' })).toBeTruthy()
  })
})

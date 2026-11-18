// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { BottleneckResponse, Me, Role } from 'shared'
import Team, { LEAD_ONLY_MESSAGE, TeamBottlenecks, TeamNavLink } from '../client/src/pages/Team'
import { useMe } from '../client/src/hooks/useMe'

vi.mock('../client/src/hooks/useMe', () => ({ useMe: vi.fn() }))

const REPOS = [
  { id: 7, fullName: 'acme/api' },
  { id: 8, fullName: 'acme/web' },
]

function signedInAs(role: Role) {
  const me: Me = { id: 1, login: `${role}-user`, role, repos: REPOS }
  vi.mocked(useMe).mockReturnValue({ status: 'ok', me })
}

const stalePr = (id: number, title: string, inactiveHours: number) => ({
  id,
  repo: 'acme/api',
  number: id,
  title,
  url: `https://github.com/acme/api/pull/${id}`,
  authorLogin: 'author-dev',
  state: 'open' as const,
  isDraft: false,
  linesChanged: 10,
  flags: { stale: true, inactiveHours, conflict: 'no' as const, behindBy: 0 },
  inactiveHours,
})

// Fixture in the API's order: highest load first (design-extension 4.3).
const FIXTURE: BottleneckResponse = {
  reviewers: [
    { login: 'busy-bea', role: 'reviewer', openRequests: 5, oldestWaitHours: 30, overloaded: true },
    { login: 'lead-li', role: 'lead', openRequests: 2, oldestWaitHours: 12, overloaded: false },
    { login: 'idle-ida', role: 'reviewer', openRequests: 0, oldestWaitHours: null, overloaded: false },
  ],
  stalePrs: [stalePr(41, 'Refactor sync', 120), stalePr(42, 'Bump deps', 80)],
  totals: { openPrs: 9, openRequests: 7, stalePrs: 2 },
}

const EMPTY: BottleneckResponse = {
  reviewers: [],
  stalePrs: [],
  totals: { openPrs: 0, openRequests: 0, stalePrs: 0 },
}

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, statusText: String(status), json: async () => body }
}

const fetchMock = vi.fn()

function bodyRows(table: HTMLElement) {
  return within(table).getAllByRole('row').slice(1) // skip the header row
}

describe('US-18 Team page', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('US-18 AC1: renders reviewers in the given order with counts; a reviewer with 0 shows 0 and "—"', () => {
    render(<TeamBottlenecks data={FIXTURE} />)

    const rows = bodyRows(screen.getByRole('table', { name: 'Reviewer load' }))
    expect(rows.map((row) => within(row).getAllByRole('cell').slice(0, 4).map((cell) => cell.textContent))).toEqual([
      ['busy-bea', 'Reviewer', '5', '30h'],
      ['lead-li', 'Lead', '2', '12h'],
      ['idle-ida', 'Reviewer', '0', '—'],
    ])
    const totals = screen.getByLabelText('Totals')
    expect(totals.textContent).toContain('Open PRs 9')
    expect(totals.textContent).toContain('Open review requests 7')
    expect(totals.textContent).toContain('Stale PRs 2')
  })

  it('US-18 AC2: shows "Overloaded" only for overloaded: true', () => {
    render(<TeamBottlenecks data={FIXTURE} />)

    const rows = bodyRows(screen.getByRole('table', { name: 'Reviewer load' }))
    expect(rows.map((row) => within(row).queryByText('Overloaded') !== null)).toEqual([true, false, false])
  })

  it('US-18 AC3: lists stale PRs with hours inactive, longest first, linking to GitHub', () => {
    render(<TeamBottlenecks data={FIXTURE} />)

    const rows = bodyRows(screen.getByRole('table', { name: 'Stale PRs' }))
    expect(rows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['Refactor sync', 'acme/api', 'author-dev', '120'],
      ['Bump deps', 'acme/api', 'author-dev', '80'],
    ])
    expect(screen.getByRole('link', { name: 'Refactor sync' }).getAttribute('href')).toBe(
      'https://github.com/acme/api/pull/41',
    )
  })

  it('US-18 AC4: changing the repo picker requests the API with that repoId', async () => {
    signedInAs('lead')
    fetchMock.mockResolvedValue(reply(200, FIXTURE))
    render(<MemoryRouter><Team /></MemoryRouter>)

    await screen.findByText('busy-bea')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/team/bottlenecks', expect.anything())

    const picker = screen.getByLabelText('Repository')
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All repositories',
      'acme/api',
      'acme/web',
    ])

    fireEvent.change(picker, { target: { value: '8' } })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith('/api/team/bottlenecks?repoId=8', expect.anything()),
    )

    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/team/bottlenecks', expect.anything()))
  })

  it('US-18 AC5: a 403 response shows the Lead-only message', async () => {
    signedInAs('reviewer')
    fetchMock.mockResolvedValue(reply(403, { error: 'Requires lead' }))
    render(<MemoryRouter><Team /></MemoryRouter>)

    expect(await screen.findByText(LEAD_ONLY_MESSAGE)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('US-18 AC5: the nav shows "Team" to Leads only', () => {
    for (const role of ['pr_author', 'reviewer'] as const) {
      signedInAs(role)
      const { unmount } = render(<MemoryRouter><TeamNavLink /></MemoryRouter>)
      expect(screen.queryByRole('link', { name: 'Team' })).toBeNull()
      unmount()
    }

    signedInAs('lead')
    render(<MemoryRouter><TeamNavLink /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Team' }).getAttribute('href')).toBe('/team')
  })

  it('US-18: empty arrays show both empty states', () => {
    render(<TeamBottlenecks data={EMPTY} />)

    expect(screen.getByText('No open review requests')).toBeTruthy()
    expect(screen.getByText('No stale PRs')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

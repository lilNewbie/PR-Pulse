import { describe, it, expect } from 'vitest'
import { computeFlags } from '../server/src/flags'
import type { PrRow } from '../server/src/db/types'

const NOW = new Date('2026-11-04T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

function pr(overrides: Partial<PrRow> = {}): PrRow {
  return {
    id: 1,
    repo_id: 1,
    repo_full_name: 'pr-pulse-test/sandbox',
    number: 7,
    title: 'PR',
    author_github_id: 1001,
    state: 'open',
    is_draft: false,
    ready_at: minutesAgo(48 * 60),
    lines_changed: 10,
    last_activity_at: minutesAgo(60),
    github_updated_at: minutesAgo(60),
    mergeable: true,
    behind_by: 0,
    base_ref: 'main',
    merge_commit_sha: null,
    merged_at: null,
    ...overrides,
  }
}

describe('US-08 Stale flag', () => {
  it('US-08 AC1: 23h59m inactive is not stale', () => {
    expect(computeFlags(pr({ last_activity_at: minutesAgo(23 * 60 + 59) }), NOW)).toMatchObject({
      stale: false,
      inactiveHours: 23,
    })
  })

  it('US-08 AC1: exactly 24h inactive is stale, with 24 whole hours', () => {
    expect(computeFlags(pr({ last_activity_at: minutesAgo(24 * 60) }), NOW)).toMatchObject({
      stale: true,
      inactiveHours: 24,
    })
  })

  it('US-08 AC1: inactive hours are whole hours, rounded down', () => {
    expect(computeFlags(pr({ last_activity_at: minutesAgo(30 * 60 + 59) }), NOW).inactiveHours).toBe(30)
  })

  it('US-08: a draft inactive for 30h is not stale', () => {
    expect(computeFlags(pr({ is_draft: true, last_activity_at: minutesAgo(30 * 60) }), NOW).stale).toBe(false)
  })

  it('US-08: merged and closed PRs are never stale', () => {
    const old = minutesAgo(100 * 60)
    expect(computeFlags(pr({ state: 'merged', last_activity_at: old }), NOW).stale).toBe(false)
    expect(computeFlags(pr({ state: 'closed', last_activity_at: old }), NOW).stale).toBe(false)
  })

  it('US-08 AC2: new activity clears stale', () => {
    expect(computeFlags(pr({ last_activity_at: minutesAgo(1) }), NOW)).toMatchObject({ stale: false, inactiveHours: 0 })
  })

  it('activity timestamp slightly in the future (clock skew) counts as 0h, not stale', () => {
    expect(computeFlags(pr({ last_activity_at: minutesAgo(-5) }), NOW)).toMatchObject({ stale: false, inactiveHours: 0 })
  })
})

describe('US-09 Conflict and behind-main flags', () => {
  it('US-09: mergeable false is a conflict', () => {
    expect(computeFlags(pr({ mergeable: false }), NOW).conflict).toBe('yes')
  })

  it('US-09: mergeable true is no conflict', () => {
    expect(computeFlags(pr({ mergeable: true }), NOW).conflict).toBe('no')
  })

  it('US-09 AC4: mergeable null shows checking', () => {
    expect(computeFlags(pr({ mergeable: null }), NOW).conflict).toBe('checking')
  })

  it('US-09: behindBy is the stored behind_by', () => {
    expect(computeFlags(pr({ behind_by: 4 }), NOW).behindBy).toBe(4)
  })

  it('flags combine: a PR can be stale, conflicting and behind at once', () => {
    expect(
      computeFlags(pr({ last_activity_at: minutesAgo(26 * 60), mergeable: false, behind_by: 2 }), NOW),
    ).toEqual({ stale: true, inactiveHours: 26, conflict: 'yes', behindBy: 2 })
  })
})

// Owned by Mandaar. Suggestions module (US-11, design-final 4 and 5.2; US-19, US-20, design-extension 4.1, 4.2).
import type { SuggestionItem } from 'shared'
import {
  directoryOf,
  findDismissTarget,
  listSuggestionRows,
  upsertDismissal,
  type SuggestionRow,
} from '../../db/suggestions'
import { computeFlags } from '../../flags'

export const MAX_REASONS = 3

// Pure: one item per PR, with at most 3 reasons, newest first. PRs are ordered by their newest reason.
export function groupSuggestions(rows: SuggestionRow[], now: Date): SuggestionItem[] {
  const byPr = new Map<number, { row: SuggestionRow; reasons: { path: string; at: Date; openRequests: number }[] }>()
  for (const row of rows) {
    const id = Number(row.id)
    const entry = byPr.get(id) ?? { row, reasons: [] }
    entry.reasons.push({ path: row.path, at: row.last_commit_at, openRequests: Number(row.open_requests) })
    byPr.set(id, entry)
  }

  return [...byPr.values()]
    .map(({ row, reasons }) => {
      const newest = reasons.sort((a, b) => b.at.getTime() - a.at.getTime() || a.path.localeCompare(b.path))
      return { row, reasons: newest.slice(0, MAX_REASONS) }
    })
    .sort((a, b) => b.reasons[0].at.getTime() - a.reasons[0].at.getTime() || Number(a.row.id) - Number(b.row.id))
    .map(({ row, reasons }) => ({
      id: Number(row.id),
      repo: row.repo_full_name,
      number: row.number,
      title: row.title,
      url: `https://github.com/${row.repo_full_name}/pull/${row.number}`,
      authorLogin: row.author_login,
      state: row.state,
      isDraft: row.is_draft,
      linesChanged: row.lines_changed,
      flags: computeFlags(row, now),
      reasons: reasons.map((r) => ({ path: r.path, lastCommitAt: r.at.toISOString(), openRequests: r.openRequests })),
      reviewRequested: row.review_requested,
    }))
}

export async function getSuggestions(userId: number, now = new Date()): Promise<SuggestionItem[]> {
  return groupSuggestions(await listSuggestionRows(userId), now)
}

export type DismissResult = 'dismissed' | 'not_found' | 'forbidden' | 'bad_path'

// US-20: hide the directory of `path` from my suggestions in the PR's repo. Checks run in this order so a PR
// in a repo I can't access says nothing about its files.
export async function dismissSuggestion(userId: number, prId: number, path: string): Promise<DismissResult> {
  const target = await findDismissTarget(userId, prId, path)
  if (!target) return 'not_found'
  if (!target.accessible) return 'forbidden'
  if (!target.has_path) return 'bad_path'
  await upsertDismissal(userId, Number(target.repo_id), directoryOf(path))
  return 'dismissed'
}

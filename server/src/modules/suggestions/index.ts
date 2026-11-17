// Owned by Mandaar. Suggestions module (US-11, design-final 4 and 5.2; US-19, design-extension 4.1).
import type { SuggestionItem } from 'shared'
import { listSuggestionRows, type SuggestionRow } from '../../db/suggestions'
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

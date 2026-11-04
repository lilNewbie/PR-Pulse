
import type { ReviewState } from 'shared'

// Owned by Mallikarjun from day 2. Alan provides the initial stubs.

export interface PrRow {
  id: number
  repo_id: number
  repo_full_name: string
  number: number
  title: string
  author_github_id: number
  state: 'open' | 'closed' | 'merged'
  is_draft: boolean
  ready_at: Date | null
  lines_changed: number
  last_activity_at: Date
  github_updated_at: Date
  mergeable: boolean | null
  behind_by: number
  base_ref: string
  merge_commit_sha: string | null
  merged_at: Date | null
}

export interface QueueRow extends PrRow {
  requested_at: Date
  sync_status: 'ok' | 'rate_limited' | 'failed'
  last_synced_at: Date | null
}

export interface PrDetailRow extends PrRow {
  author_login: string
}

export interface ReviewRequestRow {
  reviewer_login: string
  requested_at: Date
}

export interface LatestReviewRow {
  reviewer_login: string
  state: ReviewState
  submitted_at: Date
}

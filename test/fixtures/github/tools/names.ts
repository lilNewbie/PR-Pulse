// Owned by Mandaar. Maps a webhook delivery to its fixture file name.
import type { Json } from './sanitize'

export const WANTED_WEBHOOKS = [
  'pull_request.opened',
  'pull_request.ready_for_review',
  'pull_request.converted_to_draft',
  'pull_request.closed.merged',
  'pull_request.closed.unmerged',
  'pull_request.review_requested',
  'pull_request.review_request_removed',
  'pull_request.synchronize',
  'pull_request_review.submitted.approved',
  'pull_request_review.submitted.changes_requested',
  'issue_comment.created',
  'push.main',
]

export type Body = { [key: string]: Json }

export function obj(v: Json | undefined): Body {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

export function fixtureName(event: string, body: Body): string | null {
  const action = typeof body.action === 'string' ? body.action : ''
  switch (event) {
    case 'pull_request':
      if (action === 'closed') {
        return `pull_request.closed.${obj(body.pull_request).merged ? 'merged' : 'unmerged'}`
      }
      return `pull_request.${action}`
    case 'pull_request_review':
      return `pull_request_review.${action}.${String(obj(body.review).state).toLowerCase()}`
    case 'issue_comment':
      // Only comments on PRs; comments on plain issues are not PR activity.
      return obj(body.issue).pull_request ? `issue_comment.${action}` : null
    case 'push': {
      const ref = typeof body.ref === 'string' ? body.ref : ''
      return ref.startsWith('refs/heads/') ? `push.${ref.slice('refs/heads/'.length)}` : null
    }
    default:
      return null
  }
}

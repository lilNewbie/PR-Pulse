// Owned by Mandaar. PR Sync Service: the only writer of PR data (design 1.1, 4.2, Diagrams 5 and 6).
import { getGitHubToken } from '../modules/auth/token'
import * as gh from '../github/pulls'
import {
  getSyncRepo,
  listOpenPrNumbers,
  markSyncFailed,
  markSyncOk,
  upsertPr,
  withTransaction,
  type PrSnapshot,
  type SyncRepo,
} from '../db/prWrites'

export interface SyncResult {
  status: 'ok' | 'rate_limited' | 'skipped' | 'failed'
  prsUpserted: number
  prsClosed: number
  lastSyncedAt: string | null
}

// PRs updated on GitHub this recently are left to their in-flight webhook.
const WEBHOOK_GRACE_MS = 2 * 60 * 1000

const REVIEW_STATES: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
}

async function tokenFor(repo: SyncRepo): Promise<string> {
  if (repo.connectedBy === null) throw new Error(`repo ${repo.id} has no connecting user`)
  return getGitHubToken(repo.connectedBy)
}

const latest = (dates: (string | null | undefined)[]): Date =>
  new Date(Math.max(...dates.filter((d): d is string => !!d).map((d) => Date.parse(d))))

// Everything GitHub says about one PR. All GitHub calls happen here, before any write.
async function fetchSnapshot(token: string, repo: SyncRepo, prNumber: number): Promise<PrSnapshot> {
  const { owner, name } = repo
  const pull = await gh.getPull(token, owner, name, prNumber)
  const isOpen = pull.state === 'open'
  const [reviews, behindBy, commitDate, commentDate] = await Promise.all([
    gh.listReviews(token, owner, name, prNumber),
    isOpen ? gh.getBehindBy(token, owner, name, pull.base.ref, pull.head.sha) : Promise.resolve(0),
    gh.getCommitDate(token, owner, name, pull.head.sha),
    gh.getLatestCommentDate(token, owner, name, prNumber),
  ])

  const submitted = reviews
    .filter((r) => REVIEW_STATES[r.state] && r.submitted_at)
    .map((r) => ({
      githubReviewId: r.id,
      reviewerGithubId: r.user?.id ?? null,
      state: REVIEW_STATES[r.state],
      submittedAt: new Date(r.submitted_at as string),
    }))

  return {
    number: pull.number,
    title: pull.title,
    authorGithubId: pull.user.id,
    state: pull.merged_at ? 'merged' : pull.state,
    isDraft: pull.draft,
    linesChanged: (pull.additions ?? 0) + (pull.deletions ?? 0),
    // Latest commit, comment or review (US-08). Creation time is the floor.
    lastActivityAt: latest([pull.created_at, commitDate, commentDate, ...submitted.map((r) => r.submittedAt.toISOString())]),
    githubUpdatedAt: new Date(pull.updated_at),
    createdAt: new Date(pull.created_at),
    mergeable: pull.mergeable ?? null, // null = GitHub still computing; shown as "Checking…" (US-09 AC4)
    behindBy,
    baseRef: pull.base.ref,
    mergeCommitSha: pull.merged_at ? pull.merge_commit_sha : null,
    mergedAt: pull.merged_at ? new Date(pull.merged_at) : null,
    requestedReviewerIds: pull.requested_reviewers.map((u) => u.id),
    reviews: submitted,
  }
}

// Called by the Webhook Receiver after the signature check and dedup.
// On any GitHub error nothing is written; the next syncRepo repairs it.
export async function applyEvent(repoId: number, prNumber: number): Promise<void> {
  const repo = await getSyncRepo(repoId)
  if (!repo) return // disconnected since the delivery arrived
  const snapshot = await fetchSnapshot(await tokenFor(repo), repo, prNumber)
  await withTransaction((client) => upsertPr(client, repoId, snapshot))
}

// Called when a repo is connected ('initial') and by the 15-minute job ('scheduled').
export async function syncRepo(repoId: number, mode: 'initial' | 'scheduled'): Promise<SyncResult> {
  const repo = await getSyncRepo(repoId)
  if (!repo) return { status: 'failed', prsUpserted: 0, prsClosed: 0, lastSyncedAt: null }

  // Backing off after a rate limit: no GitHub calls at all (Diagram 6, step 4).
  if (repo.retryAfter && repo.retryAfter > new Date()) {
    return { status: 'skipped', prsUpserted: 0, prsClosed: 0, lastSyncedAt: repo.lastSyncedAt?.toISOString() ?? null }
  }

  try {
    const token = await tokenFor(repo)
    const open = await gh.listOpenPulls(token, repo.owner, repo.name)
    const cutoff = Date.now() - WEBHOOK_GRACE_MS
    const toRefresh = open.filter((p) => Date.parse(p.updated_at) <= cutoff).map((p) => p.number)

    // Stored as open but no longer open on GitHub: a missed close or merge (US-10 AC1).
    const listed = new Set(open.map((p) => p.number))
    const missing = (await listOpenPrNumbers(repoId)).filter((n) => !listed.has(n))

    const fresh: PrSnapshot[] = []
    for (const n of toRefresh) fresh.push(await fetchSnapshot(token, repo, n))
    const gone: PrSnapshot[] = []
    for (const n of missing) gone.push(await fetchSnapshot(token, repo, n))

    // All writes in one transaction, only after every GitHub call succeeded.
    return await withTransaction(async (client) => {
      let prsUpserted = 0
      let prsClosed = 0
      for (const s of fresh) if (await upsertPr(client, repoId, s)) prsUpserted++
      for (const s of gone) if (await upsertPr(client, repoId, s)) prsClosed++
      const lastSyncedAt = await markSyncOk(client, repoId, mode === 'initial')
      return { status: 'ok' as const, prsUpserted, prsClosed, lastSyncedAt: lastSyncedAt.toISOString() }
    })
  } catch (err) {
    const rateLimitedUntil = err instanceof gh.GitHubApiError ? err.rateLimitResetAt : null
    await markSyncFailed(repoId, rateLimitedUntil ? 'rate_limited' : 'failed', rateLimitedUntil)
    if (!rateLimitedUntil) {
      console.error(`sync: repo ${repoId} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return {
      status: rateLimitedUntil ? 'rate_limited' : 'failed',
      prsUpserted: 0,
      prsClosed: 0,
      lastSyncedAt: repo.lastSyncedAt?.toISOString() ?? null,
    }
  }
}

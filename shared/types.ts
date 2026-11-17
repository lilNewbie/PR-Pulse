
export type Role = 'pr_author' | 'reviewer' | 'lead'

export type PrState = 'open' | 'closed' | 'merged'

export type ReviewState = 'approved' | 'changes_requested' | 'commented'

export interface Flags {
  stale: boolean
  inactiveHours: number
  conflict: 'yes' | 'no' | 'checking'
  behindBy: number
}

export interface PrSummary {
  id: number
  repo: string
  number: number
  title: string
  url: string
  authorLogin: string
  state: PrState
  isDraft: boolean
  linesChanged: number
  flags: Flags
}

export interface PrDetail extends PrSummary {
  reviewRequests: {
    reviewerLogin: string
    requestedAt: string
  }[]
  reviews: {
    reviewerLogin: string
    state: ReviewState
    submittedAt: string
  }[]
}

export interface QueueItem extends PrSummary {
  waitingHours: number
  position: number
  isReleaseBlocker: boolean
}

export interface QueueResponse {
  items: QueueItem[]
  lastSyncedAt: string | null
  syncWarning: boolean
}

export interface MyPrsResponse {
  items: PrSummary[]
}

export interface Me {
  id: number
  login: string
  role: Role
  repos: {
    id: number
    fullName: string
  }[]
}

export interface ApiError {
  error: string
}

export interface SuggestionReason { path: string; lastCommitAt: string }
export interface SuggestionItem extends PrSummary { reasons: SuggestionReason[]; reviewRequested: boolean }
export interface ExpertiseArea { area: string; commits: number; lastCommitAt: string }
export interface ExpertiseResponse { repo: { id: number; fullName: string }; areas: ExpertiseArea[] }
export type DeploymentStatus = 'pending' | 'success' | 'failed'
export interface DeploymentSummary {
  id: number
  sha: string
  environment: 'staging' | 'production'
  status: DeploymentStatus
  source: 'manual' | 'webhook'
  createdAt: string
  prCount: number
}
export interface DeploymentDetail extends DeploymentSummary {
  previousDeploymentId: number | null
  prs: { number: number; title: string; authorLogin: string; mergedAt: string; url: string }[]
}

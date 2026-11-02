export type Role = 'pr_author' | 'reviewer' | 'lead'
export type PrState = 'open' | 'closed' | 'merged'

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

export interface QueueItem extends PrSummary {
  waitingHours: number
  position: number
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
  repos: { id: number; fullName: string }[]
}

export interface ApiError {
  error: string
}

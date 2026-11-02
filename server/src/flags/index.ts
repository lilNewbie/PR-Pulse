import type { Flags } from 'shared'
import type { PrRow } from '../db/types'

// Owned by Mandaar. Pure function, no DB or HTTP access.
export function computeFlags(_pr: PrRow, _now: Date): Flags {
  return {
    stale: false,
    inactiveHours: 0,
    conflict: 'no',
    behindBy: 0,
  }
}

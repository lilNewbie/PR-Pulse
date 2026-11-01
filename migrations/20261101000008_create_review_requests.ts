import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('review_requests', {
    pr_id: { type: 'bigint', notNull: true, references: '"pull_requests"', onDelete: 'CASCADE' },
    reviewer_github_id: { type: 'bigint', notNull: true },
    requested_at: { type: 'timestamptz', notNull: true },
  })
  pgm.addConstraint(
    'review_requests',
    'review_requests_pkey',
    'PRIMARY KEY (pr_id, reviewer_github_id)',
  )
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('review_requests')
}

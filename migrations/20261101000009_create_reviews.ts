import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('reviews', {
    id: { type: 'bigserial', primaryKey: true },
    github_review_id: { type: 'bigint', unique: true },
    pr_id: { type: 'bigint', notNull: true, references: '"pull_requests"', onDelete: 'CASCADE' },
    reviewer_github_id: { type: 'bigint' },
    state: { type: 'text' },
    submitted_at: { type: 'timestamptz' },
  })
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('reviews')
}

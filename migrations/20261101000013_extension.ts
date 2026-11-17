import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('suggestion_feedback', {
    user_id: { type: 'bigint', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    repo_id: { type: 'bigint', notNull: true, references: '"repos"', onDelete: 'CASCADE' },
    directory: { type: 'text', notNull: true },
    dismissed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('suggestion_feedback', 'suggestion_feedback_pkey', 'PRIMARY KEY (user_id, repo_id, directory)')

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS review_requests_reviewer_github_id_idx
    ON review_requests (reviewer_github_id)
  `)
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('suggestion_feedback')
}

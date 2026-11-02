import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('pull_requests', {
    id: { type: 'bigserial', primaryKey: true },
    repo_id: { type: 'bigint', notNull: true, references: '"repos"', onDelete: 'CASCADE' },
    number: { type: 'integer', notNull: true },
    title: { type: 'text', notNull: true },
    author_github_id: { type: 'bigint', notNull: true },
    state: {
      type: 'text',
      notNull: true,
      check: "state IN ('open','closed','merged')",
    },
    is_draft: { type: 'boolean', notNull: true, default: false },
    ready_at: { type: 'timestamptz' },
    lines_changed: { type: 'integer', check: 'lines_changed >= 0' },
    last_activity_at: { type: 'timestamptz', notNull: true },
    github_updated_at: { type: 'timestamptz', notNull: true },
    mergeable: { type: 'boolean' },
    behind_by: { type: 'integer', notNull: true, default: 0, check: 'behind_by >= 0' },
    base_ref: { type: 'text', notNull: true },
    merge_commit_sha: { type: 'text' },
    merged_at: { type: 'timestamptz' },
  })
  pgm.addConstraint('pull_requests', 'pull_requests_repo_number_unique', 'UNIQUE (repo_id, number)')
  pgm.createIndex('pull_requests', ['repo_id', 'state'])
  pgm.createIndex('pull_requests', 'author_github_id')
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('pull_requests')
}

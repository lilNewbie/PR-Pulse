import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  // deployments — created here because US-16 migration was never merged
  pgm.createTable('deployments', {
    id: { type: 'bigserial', primaryKey: true },
    repo_id: { type: 'bigint', notNull: true, references: '"repos"', onDelete: 'CASCADE' },
    sha: { type: 'text', notNull: true },
    environment: {
      type: 'text',
      notNull: true,
      check: "environment IN ('staging','production')",
    },
    status: {
      type: 'text',
      notNull: true,
      check: "status IN ('pending','success','failed')",
    },
    source: {
      type: 'text',
      notNull: true,
      check: "source IN ('manual','webhook')",
    },
    external_identifier: { type: 'text' },
    recorded_by: { type: 'bigint', references: '"users"', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('deployments', 'deployments_repo_sha_env_unique', 'UNIQUE (repo_id, sha, environment)')

  // is_release_blocker on pull_requests (US-04)
  pgm.addColumn('pull_requests', {
    is_release_blocker: { type: 'boolean', notNull: true, default: false },
  })

  // pr_files
  pgm.createTable('pr_files', {
    pr_id: { type: 'bigint', notNull: true, references: '"pull_requests"', onDelete: 'CASCADE' },
    path: { type: 'text', notNull: true },
  })
  pgm.addConstraint('pr_files', 'pr_files_pkey', 'PRIMARY KEY (pr_id, path)')

  // file_touches
  pgm.createTable('file_touches', {
    repo_id: { type: 'bigint', notNull: true, references: '"repos"', onDelete: 'CASCADE' },
    path: { type: 'text', notNull: true },
    author_login: { type: 'text', notNull: true },
    commit_sha: { type: 'text', notNull: true },
    committed_at: { type: 'timestamptz', notNull: true },
  })
  pgm.addConstraint('file_touches', 'file_touches_pkey', 'PRIMARY KEY (repo_id, path, commit_sha)')
  pgm.createIndex('file_touches', [{ name: 'repo_id' }, { name: 'path' }, { name: 'committed_at', sort: 'DESC' }])
  pgm.createIndex('file_touches', ['repo_id', 'author_login'])

  // deployment_prs
  pgm.createTable('deployment_prs', {
    deployment_id: { type: 'bigint', notNull: true, references: '"deployments"', onDelete: 'CASCADE' },
    pr_id: { type: 'bigint', notNull: true, references: '"pull_requests"', onDelete: 'CASCADE' },
  })
  pgm.addConstraint('deployment_prs', 'deployment_prs_pkey', 'PRIMARY KEY (deployment_id, pr_id)')
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('deployment_prs')
  pgm.dropTable('file_touches')
  pgm.dropTable('pr_files')
  pgm.dropColumn('pull_requests', 'is_release_blocker')
  pgm.dropTable('deployments')
}

import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('repo_access', {
    user_id: { type: 'bigint', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    repo_id: { type: 'bigint', notNull: true, references: '"repos"', onDelete: 'CASCADE' },
    checked_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('repo_access', 'repo_access_pkey', 'PRIMARY KEY (user_id, repo_id)')
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('repo_access')
}

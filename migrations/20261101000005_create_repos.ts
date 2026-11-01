import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('repos', {
    id: { type: 'bigserial', primaryKey: true },
    team_id: { type: 'bigint', notNull: true, references: '"teams"', onDelete: 'CASCADE' },
    github_repo_id: { type: 'bigint', notNull: true, unique: true },
    owner: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    hook_id: { type: 'bigint' },
    webhook_secret_enc: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      check: "status IN ('connecting','connected')",
    },
    sync_status: {
      type: 'text',
      notNull: true,
      default: "'ok'",
      check: "sync_status IN ('ok','rate_limited','failed')",
    },
    retry_after: { type: 'timestamptz' },
    last_synced_at: { type: 'timestamptz' },
    connected_by: { type: 'bigint', references: '"users"', onDelete: 'SET NULL' },
  })
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('repos')
}

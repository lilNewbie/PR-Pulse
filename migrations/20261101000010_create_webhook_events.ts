import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('webhook_events', {
    delivery_id: { type: 'text', primaryKey: true },
    repo_id: { type: 'bigint', references: '"repos"', onDelete: 'SET NULL' },
    event_type: { type: 'text' },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('webhook_events')
}

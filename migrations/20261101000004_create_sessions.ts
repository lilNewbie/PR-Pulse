import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('sessions', {
    id: { type: 'text', primaryKey: true },
    user_id: { type: 'bigint', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    expires_at: { type: 'timestamptz', notNull: true },
  })
  pgm.createIndex('sessions', 'user_id')
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('sessions')
}

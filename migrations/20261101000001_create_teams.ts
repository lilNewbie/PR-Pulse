import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('teams', {
    id: { type: 'bigserial', primaryKey: true },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('teams')
}

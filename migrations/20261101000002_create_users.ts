import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('users', {
    id: { type: 'bigserial', primaryKey: true },
    github_id: { type: 'bigint', notNull: true, unique: true },
    login: { type: 'text', notNull: true },
    github_token_enc: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('users')
}

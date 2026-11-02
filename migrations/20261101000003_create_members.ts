import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('members', {
    team_id: { type: 'bigint', notNull: true, references: '"teams"', onDelete: 'CASCADE' },
    user_id: { type: 'bigint', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    role: {
      type: 'text',
      notNull: true,
      check: "role IN ('pr_author','reviewer','lead')",
    },
  })
  pgm.addConstraint('members', 'members_pkey', 'PRIMARY KEY (team_id, user_id)')
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('members')
}

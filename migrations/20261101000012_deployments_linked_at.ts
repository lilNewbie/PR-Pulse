import { MigrationBuilder } from 'node-pg-migrate'

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn('deployments', {
    linked_at: { type: 'timestamptz' },
  })
}

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn('deployments', 'linked_at')
}

// Fixture for column-renames-server.spec.ts — `@db.column` renames on a
// top-level scalar and a top-level object (whose nested keys are stored
// as-is) must hold on every non-grouped read control: filter, `$select`
// and `$sort`.

@db.table 'column_renames'
export interface ColumnRename {
    @meta.id
    id: number

    title: string

    @db.column 'opened_on'
    renamedAt?: number.timestamp

    @db.column 'prof'
    profile?: {
        bio?: string
        rank?: number
    }
}

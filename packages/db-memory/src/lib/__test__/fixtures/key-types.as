// Key parts typed by a nullable union and by number literals.

@db.table 'kt_codes'
export interface KtCode {
    @meta.id
    id: string

    @db.index.unique
    code: number | null

    title: string
}

@db.table 'kt_levels'
export interface KtLevel {
    @meta.id
    level: 1 | 2 | 3

    title: string
}

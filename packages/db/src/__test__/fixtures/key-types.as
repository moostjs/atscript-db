// Key parts typed by a nullable union, by number literals, and as an integer
// (`number.int`, and `@expect.int` on a nullable number).

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

@db.table 'kt_counters'
export interface KtCounter {
    @meta.id
    n: number.int

    title: string
}

@db.table 'kt_tickets'
export interface KtTicket {
    @meta.id
    id: string

    @db.index.unique
    @expect.int
    seq: number | null

    title: string
}

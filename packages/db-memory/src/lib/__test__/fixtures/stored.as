@db.table 'users'
export interface User {
    @meta.id
    id: string

    name: string

    @db.index.unique 'email_idx'
    email: string

    age: number

    nickname?: string

    tags?: string[]

    @db.column.version
    version: number.int

    @db.patch.strategy 'merge'
    profile?: {
        city: string
        age: number
    }
}

@db.table 'composites'
export interface Composite {
    @meta.id
    part1: string

    @meta.id
    part2: string

    label: string
}

@db.table 'jobs'
export interface Job {
    @meta.id
    jobName: string

    scheduled: boolean

    age: number
}

@db.table 'sequences'
export interface Sequence {
    @meta.id
    @db.default.increment
    id: number

    label: string
}

@db.table 'tickets'
export interface Ticket {
    @meta.id
    @db.default.increment 100
    ticketNo: number

    subject: string
}

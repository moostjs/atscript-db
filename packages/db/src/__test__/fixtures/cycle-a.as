import { CycleB } from './cycle-b'

@db.table 'cycle_a'
export interface CycleA {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    bId?: CycleB.id
}

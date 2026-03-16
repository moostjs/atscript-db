import { CycleA } from './cycle-a'

@db.table 'cycle_b'
export interface CycleB {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    aId?: CycleA.id
}

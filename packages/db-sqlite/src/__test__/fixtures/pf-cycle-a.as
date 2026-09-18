import { PfCycleB } from './pf-cycle-b'

@db.table 'pf_cycle_a'
export interface PfCycleA {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.FK
    bId?: PfCycleB.id
}

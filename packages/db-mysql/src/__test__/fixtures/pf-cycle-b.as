import { PfCycleA } from './pf-cycle-a'

@db.table 'pf_cycle_b'
export interface PfCycleB {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.FK
    aId?: PfCycleA.id
}

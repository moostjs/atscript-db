// A row cap per parent (row-cap.live.spec.ts): at most N items per household.

@db.table 'rc_households'
export interface RcHousehold {
    @meta.id
    id: number

    name: string
}

@db.table 'rc_items'
export interface RcItem {
    @meta.id
    id: number

    @db.rel.FK
    householdId: RcHousehold.id

    name: string
}

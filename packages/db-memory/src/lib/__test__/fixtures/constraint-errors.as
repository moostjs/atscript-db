// Constraint-error normalisation (constraint-errors.spec.ts). Since 0.1.165.

@db.table 'ce_households'
export interface CeHousehold {
    @meta.id
    id: number.int

    name: string
}

@db.table 'ce_people'
export interface CePerson {
    @meta.id
    id: number.int

    name: string
}

@db.table 'ce_items'
export interface CeItem {
    @meta.id
    id: number.int

    @db.index.unique 'ce_household_name'
    @db.rel.FK
    @db.rel.onDelete 'restrict'
    householdId: CeHousehold.id

    @db.index.unique 'ce_household_name'
    name: string

    @db.index.unique 'ce_code'
    code: string

    @db.rel.FK
    ownerId?: CePerson.id
}

// A composite foreign key (application-level check on this adapter).
@db.table 'ce_slots'
export interface CeSlot {
    @meta.id
    id: number.int

    @db.index.unique 'ce_slot_key'
    a: number.int

    @db.index.unique 'ce_slot_key'
    b: number.int
}

@db.table 'ce_reservations'
export interface CeReservation {
    @meta.id
    id: number.int

    @db.rel.FK 'slot'
    slotA: CeSlot.a

    @db.rel.FK 'slot'
    slotB: CeSlot.b
}

// Constraint-error normalisation (constraint-errors.spec.ts). Since 0.1.165.

@db.table 'ce_items'
@db.mongo.collection
export interface CeItem {
    @meta.id
    _id: string

    @db.index.unique 'ce_household_name'
    householdId: number.int

    @db.index.unique 'ce_household_name'
    name: string
}

@db.table 'ref_sources'
@db.table.preferredId.uniqueIndex 'by_code'
export interface RefSource {
    @meta.id
    _id: string

    @meta.label 'Code'
    @db.index.unique 'by_code'
    code: number.int

    currency: string

    @db.amount.currency.ref 'currency'
    total: decimal

    @db.unit 'kg'
    weight: decimal
}

export interface RefDict {
    code: RefSource.code
}

@db.table 'ref_onehops'
export interface RefOneHop {
    @meta.id
    _id: string

    @db.rel.FK
    code: RefSource.code

    total: RefSource.total

    weight: RefSource.weight
}

@db.table 'ref_twohops'
export interface RefTwoHop {
    @meta.id
    _id: string

    @db.index.unique 'by_local'
    code: RefDict.code
}

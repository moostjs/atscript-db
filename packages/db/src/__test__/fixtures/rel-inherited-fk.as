// A table whose foreign keys are inherited from its base type: the
// relations declared on the table load through them.

@db.table 'ri_customers'
export interface RiCustomer {
    @meta.id
    id: number

    name: string
}

@db.table 'ri_boards'
export interface RiBoard {
    @meta.id
    org: string

    @meta.id
    code: string

    title: string
}

export interface RiOrderBase {
    @meta.id
    id: number

    @db.rel.FK
    customerId?: RiCustomer.id

    @db.rel.FK 'board'
    boardOrg?: RiBoard.org
}

@db.table 'ri_orders'
export interface RiOrder extends RiOrderBase {
    title: string

    @db.rel.FK 'board'
    boardCode?: RiBoard.code

    @db.rel.to
    customer?: RiCustomer

    @db.rel.to 'board'
    board?: RiBoard
}

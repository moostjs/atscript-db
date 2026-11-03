// Entity annotations stay on the declaring interface (since 0.1.141): a
// @db.alias and a field typed with a table carry none — only the table itself
// is a DB entity at runtime. A plain type alias is the table itself
// (@atscript/typescript 0.2).

@db.table 'ae_customers'
@db.schema 'sales'
@db.depth.limit 1
export interface AeCustomer {
    @meta.id
    id: number
    name: string

    @db.rel.from
    orders: AeOrder[]
}

@db.table 'ae_orders'
export interface AeOrder {
    @meta.id
    id: number

    @db.rel.FK
    customerId: AeCustomer.id

    @db.rel.to
    customer?: AeCustomer

    amount: number
}

// A join scope over ae_customers — not a table
@db.alias AeCustomer
export type AeParent = AeCustomer

// A plain alias of the table type — the table itself, under a second name
export type AeBuyer = AeCustomer

// A plain interface whose fields are typed with a table
export interface AeOrderNote {
    customer: AeCustomer
    others: AeCustomer[]
}

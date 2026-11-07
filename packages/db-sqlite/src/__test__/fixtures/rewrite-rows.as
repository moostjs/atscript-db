// `rewriteRowsStep` (since 0.1.175): the same table under two limits, a twin
// that differs only in a label, and a composite-key table.

@db.table 'rw_chats'
export interface RwChat {
    @meta.id
    id: number.int

    title: string

    @db.json
    @expect.maxLength 5
    turns: string[]
}

@db.table 'rw_chats'
export interface RwChatLabeled {
    @meta.id
    id: number.int

    @meta.label 'Title'
    title: string

    @db.json
    @expect.maxLength 5
    @meta.label 'Turns'
    turns: string[]
}

@db.table 'rw_chats'
export interface RwChatV2 {
    @meta.id
    id: number.int

    title: string

    @db.json
    @expect.maxLength 3
    turns: string[]
}

@db.table 'rw_pairs'
export interface RwPair {
    @meta.id
    a: number.int

    @meta.id
    b: number.int

    v: string
}

// The same JSON column typed with differently named nested interfaces, and a
// table with an unrelated extra column: none changes a field's step id.
export interface RwPartA {
    @meta.label 'Items'
    items: string[]
}

export interface RwPartB {
    items: string[]
}

@db.table 'rw_nested'
export interface RwNestedA {
    @meta.id
    id: number.int

    @db.json
    @expect.maxKeys 4
    part: RwPartA
}

@db.table 'rw_nested'
export interface RwNestedB {
    @meta.id
    id: number.int

    @db.json
    @expect.maxKeys 4
    part: RwPartB

    @meta.label 'Extra'
    extra?: string
}

// Relations and keys cannot be rewritten.
@db.table 'rw_owners'
export interface RwOwner {
    @meta.id
    id: number.int

    name: string

    @db.rel.from
    notes?: RwNote[]
}

@db.table 'rw_notes'
export interface RwNote {
    @meta.id
    id: number.int

    @db.rel.FK
    ownerId: RwOwner.id

    @db.rel.to
    owner?: RwOwner
}

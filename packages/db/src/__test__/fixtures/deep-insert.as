// Fixture for @db.deep.insert annotation — success/failure cases are
// exercised by packages/db/src/__test__/deep-insert-enforcement.spec.ts.
//
// Each annotated parent has its own child chain (FKs point back at the
// matching parent) so the fixture compiles without cross-parent FK conflicts.

@db.table 'deep_zero'
@db.deep.insert 0
export interface DeepZero {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.from
    children?: DeepZeroChild[]
}

@db.table 'deep_zero_child'
export interface DeepZeroChild {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.FK
    parentId: DeepZero.id

    @db.rel.to
    parent?: DeepZero
}

@db.table 'deep_two'
@db.deep.insert 2
export interface DeepTwo {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.from
    children?: DeepTwoChild[]
}

@db.table 'deep_two_child'
export interface DeepTwoChild {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.FK
    parentId: DeepTwo.id

    @db.rel.to
    parent?: DeepTwo

    @db.rel.from
    grandchildren?: DeepTwoGrandchild[]
}

@db.table 'deep_two_grandchild'
export interface DeepTwoGrandchild {
    @meta.id
    @db.default.increment
    id: number

    label: string

    @db.rel.FK
    childId: DeepTwoChild.id

    @db.rel.to
    child?: DeepTwoChild

    @db.rel.from
    greatgrandchildren?: DeepTwoGreatGrandchild[]
}

@db.table 'deep_two_great_grandchild'
export interface DeepTwoGreatGrandchild {
    @meta.id
    @db.default.increment
    id: number

    tag: string

    @db.rel.FK
    grandchildId: DeepTwoGrandchild.id

    @db.rel.to
    grandchild?: DeepTwoGrandchild
}

@db.table 'implicit_default'
export interface ImplicitDefault {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.rel.from
    children?: ImplicitDefaultChild[]
}

@db.table 'implicit_default_child'
export interface ImplicitDefaultChild {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.FK
    parentId: ImplicitDefault.id

    @db.rel.to
    parent?: ImplicitDefault
}

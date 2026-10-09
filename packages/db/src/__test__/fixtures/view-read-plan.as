// AtscriptDbView.readPlan truth table (since 0.1.153).

@db.table 'rp_b'
export interface RpB {
    @meta.id
    id: number
    name: string
    score?: number
    cId?: number
}

@db.table 'rp_c'
export interface RpC {
    @meta.id
    id: number
    name: string
}

@db.table 'rp_d'
export interface RpD {
    @meta.id
    id: number
    @db.index.unique 'dk'
    k1: string
    @db.index.unique 'dk'
    k2: number
    name: string
}

@db.table 'rp_e'
export interface RpE {
    @meta.id
    id: number
    @db.index.unique 'e_code'
    @db.column.collate 'nocase'
    code: string
    name: string
}

@db.table 'rp_g'
export interface RpG {
    @meta.id
    id: number
    @db.index.unique 'g_slug'
    slug?: string
    name: string
}

@db.table 'rp_n'
export interface RpN {
    @meta.id
    id: number
    aId: number
    at: number
    text: string
}

@db.table 'rp_a'
export interface RpA {
    @meta.id
    id: number
    bId?: number
    code?: string
    num?: number
}

@db.alias RpB
export type RpB2 = RpB

// Chained: C is reached through B
@db.view 'rp_chain'
@db.view.for RpA
@db.view.joins RpB, `RpB.id = RpA.bId`, 'left'
@db.view.joins RpC, `RpC.id = RpB.cId`, 'left'
export interface RpChain {
    id: RpA.id
    bName?: RpB.name
    cName?: RpC.name
    bScore?: RpB.score

    @db.compute `coalesce(bScore, 0) * 2`
    dbl: number
}

@db.view 'rp_composite'
@db.view.for RpA
@db.view.joins RpD, `RpD.k1 = RpA.code and RpD.k2 = RpA.num`, 'left'
export interface RpComposite {
    id: RpA.id
    dName?: RpD.name
}

@db.view 'rp_composite_partial'
@db.view.for RpA
@db.view.joins RpD, `RpD.k1 = RpA.code and RpD.name = 'x'`, 'left'
export interface RpCompositePartial {
    id: RpA.id
    dName?: RpD.name
}

@db.view 'rp_composite_literal'
@db.view.for RpA
@db.view.joins RpD, `RpD.k1 = 'x' and RpD.k2 = RpA.num and RpD.name != 'y'`, 'left'
export interface RpCompositeLiteral {
    id: RpA.id
    dName?: RpD.name
}

@db.view 'rp_composite_or'
@db.view.for RpA
@db.view.joins RpD, `RpD.k1 = RpA.code or RpD.k2 = RpA.num`, 'left'
export interface RpCompositeOr {
    id: RpA.id
    dName?: RpD.name
}

// k2 (number) compared with a string column — no implicit cast is trusted
@db.view 'rp_composite_types'
@db.view.for RpA
@db.view.joins RpD, `RpD.k1 = RpA.code and RpD.k2 = RpA.code`, 'left'
export interface RpCompositeTypes {
    id: RpA.id
    dName?: RpD.name
}

@db.view 'rp_inner'
@db.view.for RpA
@db.view.joins RpB, `RpB.id = RpA.bId`, 'inner'
@db.view.joins RpB2, `RpB2.id = RpA.bId`, 'left'
export interface RpInner {
    id: RpA.id
    bName: RpB.name
    b2Name?: RpB2.name
}

@db.view 'rp_first'
@db.view.for RpA
@db.view.joins RpN, `RpN.aId = RpA.id`, 'left', `at desc`
export interface RpFirst {
    id: RpA.id
    lastText?: RpN.text
}

@db.view 'rp_first_inner'
@db.view.for RpA
@db.view.joins RpN, `RpN.aId = RpA.id`, 'inner', `at desc`
export interface RpFirstInner {
    id: RpA.id
    lastText: RpN.text
}

@db.view 'rp_filtered'
@db.view.for RpA
@db.view.joins RpB, `RpB.id = RpA.bId`, 'left'
@db.view.joins RpB2, `RpB2.id = RpA.bId`, 'left'
@db.view.filter `RpB.score > 0`
export interface RpFiltered {
    id: RpA.id
    b2Name?: RpB2.name
}

// The left side reads a byte-wise column, the unique key compares case-insensitively
@db.view 'rp_collate'
@db.view.for RpA
@db.view.joins RpE, `RpE.code = RpA.code`, 'left'
export interface RpCollate {
    id: RpA.id
    eName?: RpE.name
}

// A unique key over an OPTIONAL field: unique on SQL, partial on a document store
@db.view 'rp_optional_key'
@db.view.for RpA
@db.view.joins RpG, `RpG.slug = RpA.code`, 'left'
export interface RpOptionalKey {
    id: RpA.id
    gName?: RpG.name
}

// The join target is a view — its uniqueness is unknown
@db.view 'rp_view_target'
@db.view.for RpA
@db.view.joins RpChain, `RpChain.id = RpA.id`, 'left'
export interface RpViewTarget {
    id: RpA.id
    chainB?: RpChain.bName
}

@db.view 'rp_grouped'
@db.view.for RpB
@db.view.joins RpC, `RpC.id = RpB.cId`, 'left'
export interface RpGrouped {
    name: RpB.name
    @db.agg.count
    n: number
}

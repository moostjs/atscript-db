// View read pruning, adversarial shapes (since 0.1.153): collations, a
// boolean-literal key pin, a self alias chain, an inner join reading a left
// join, a first-row join over a left join, a nested object column. Shared by
// db-mysql / db-mongo.

@db.table 'va_codes'
export interface VaCode {
    @meta.id
    id: number
    @db.column.collate 'nocase'
    @db.index.unique 'va_code'
    code: string
    label: string
}

// Unique under binary comparison — 'a' and 'A' coexist
@db.table 'va_bincodes'
export interface VaBinCode {
    @meta.id
    id: number
    @db.column.collate 'binary'
    @db.index.unique 'va_bincode'
    code: string
    label: string
}

@db.table 'va_tiers'
export interface VaTier {
    @meta.id
    id: number
    @db.index.unique 'va_tier'
    kind: string
    @db.index.unique 'va_tier'
    premium: boolean
    title: string
}

@db.table 'va_owners'
export interface VaOwner {
    @meta.id
    id: number
    name: string
    tierKind?: string
    bossId?: number
    meta?: {
        level: number
    }
}

@db.table 'va_events'
export interface VaEvent {
    @meta.id
    id: number
    ownerId: number
    at: number
    text: string
}

@db.table 'va_items'
export interface VaItem {
    @meta.id
    id: number
    @db.column.collate 'nocase'
    code?: string
    qty: number
    ownerId?: number
}

@db.alias VaOwner
export type VaBoss = VaOwner

@db.alias VaEvent
export type VaLastEvent = VaEvent

@db.view 'va_item_view'
@db.view.for VaItem
@db.view.joins VaCode, `VaCode.code = VaItem.code`, 'left'
@db.view.joins VaOwner, `VaOwner.id = VaItem.ownerId`, 'left'
@db.view.joins VaBoss, `VaBoss.id = VaOwner.bossId`, 'left'
@db.view.joins VaTier, `VaTier.kind = VaOwner.tierKind and VaTier.premium = true`, 'left'
@db.view.joins VaLastEvent, `VaLastEvent.ownerId = VaOwner.id`, 'left', `at desc`
export interface VaItemView {
    id: VaItem.id
    qty: VaItem.qty
    codeLabel?: VaCode.label
    ownerName?: VaOwner.name
    ownerLevel?: VaOwner.meta.level
    bossName?: VaBoss.name
    tierTitle?: VaTier.title
    lastEvent?: VaLastEvent.text

    @db.compute `qty * coalesce(ownerLevel, 1)`
    weight?: number
}

// An inner join that reads a left join: the left join filters rows too
@db.view 'va_inner_chain_view'
@db.view.for VaItem
@db.view.joins VaOwner, `VaOwner.id = VaItem.ownerId`, 'left'
@db.view.joins VaBoss, `VaBoss.id = VaOwner.bossId`, 'inner'
export interface VaInnerChainView {
    id: VaItem.id
    qty: VaItem.qty
    bossName: VaBoss.name
}

// A binary-unique target compared under the source's nocase collation:
// 'a' and 'A' both match — never droppable (SQLite / MongoDB only: MySQL
// rejects the mix of collations)
@db.view 'va_bin_view'
@db.view.for VaItem
@db.view.joins VaBinCode, `VaItem.code = VaBinCode.code`, 'left'
export interface VaBinView {
    id: VaItem.id
    qty: VaItem.qty
    binLabel?: VaBinCode.label
}

// MongoDB only: a composite `@meta.id` beside an explicit `_id` is unique as
// a pair (one `__pk` index) — neither field alone is
@db.table 'va_pairs'
@db.mongo.collection
export interface VaPair {
    @meta.id
    a: number
    @meta.id
    b: number
    label: string
}

@db.view 'va_pair_view'
@db.view.for VaItem
@db.view.joins VaPair, `VaPair.a = VaItem.ownerId`, 'left'
export interface VaPairView {
    id: VaItem.id
    pairLabel?: VaPair.label
}

// Fixtures for schema-sync pre-flight refusals and dependency ordering.
// Same physical table names appear in several versions ("V1"/"V2") so a
// single DbSpace can sync the "before" model and then the "after" model.

// ── Primary-key move: pf_tokens ─────────────────────────────────────────

@db.table 'pf_tokens'
export interface PfTokenV1 {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'pf_code_idx'
    code: string

    label: string
}

// PK moved to `code`; `id` stays as a plain unique column (no increment)
@db.table 'pf_tokens'
export interface PfTokenV2 {
    @meta.id
    code: string

    @db.index.unique 'pf_id_idx'
    id: number

    label: string
}

// PK moved to `code` but `id` keeps @db.default.increment → refused
@db.table 'pf_tokens'
export interface PfTokenV2Inc {
    @meta.id
    code: string

    @db.default.increment
    id: number

    label: string
}

// PK moved to `code` AND the table renamed in the same sync — the populated
// check must probe the OLD name (an adapter that cannot → refused)
@db.table 'pf_tokens_v2'
@db.table.renamed 'pf_tokens'
export interface PfTokenRenamed {
    @meta.id
    code: string

    id: number

    label: string
}

// ── FK change + PK change on one table (SQLite-like recreate path) ──────

@db.table 'pf_links'
export interface PfLinkV1 {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    tokenId: PfTokenV1.id
}

// Key moves to `code` and the FK is dropped in the same sync: an adapter
// without `syncForeignKeys` recreates the table (which carries the new key)
@db.table 'pf_links'
export interface PfLinkV2 {
    @meta.id
    code: string

    id: number

    tokenId: number
}

// ── Children of pf_tokens ────────────────────────────────────────────────

// References the OLD key
@db.table 'pf_children'
export interface PfChildOld {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    tokenId: PfTokenV1.id
}

// Same FK column retargeted to the NEW key in the same sync
@db.table 'pf_children'
export interface PfChildNew {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    tokenId: PfTokenV2.code
}

// Retargets like PfChildNew but is ALSO renamed in the same sync → refused
// (its adapter resolves the new name; the old constraint could not be dropped)
@db.table 'pf_kids'
@db.table.renamed 'pf_children'
export interface PfChildRenamed {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    tokenId: PfTokenV2.code
}

// ── Unknown FK target ────────────────────────────────────────────────────

@db.table 'pf_ghosts'
export interface PfGhost {
    @meta.id
    @db.default.increment
    id: number
}

// PfGhost is never passed to sync → its table must exist in the DB or the run is refused
@db.table 'pf_orphans'
export interface PfOrphan {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    ghostId: PfGhost.id
}

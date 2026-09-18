// Schema-sync pre-flight / dependency-order fixtures. Several interfaces share
// one table name ("V1" / "V2" / …) so a single space can sync a "before" model
// and then an "after" model over the same physical table.

// ── Primary-key move ─────────────────────────────────────────────────────

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

// Key moved to a NEW increment column; the old AUTO_INCREMENT key stays as a plain number
@db.table 'pf_tokens'
export interface PfTokenSeq {
    @meta.id
    @db.default.increment
    seq: number

    id: number

    @db.index.unique 'pf_code_idx'
    code: string

    label: string
}

// PK moved to `code` and the old key column removed in the same sync
@db.table 'pf_tokens'
export interface PfTokenDropOld {
    @meta.id
    code: string

    label: string
}

// ── Parent / child / bystander (drop ordering) ───────────────────────────

@db.table 'pf_parents'
export interface PfParent {
    @meta.id
    @db.default.increment
    id: number

    name: string
}

@db.table 'pf_children'
export interface PfChild {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    parentId: PfParent.id

    note?: string
}

@db.table 'pf_survivors'
export interface PfSurvivor {
    @meta.id
    @db.default.increment
    id: number

    name: string
}

// ── Three-level chain (create ordering) ──────────────────────────────────

@db.table 'pf_teams'
export interface PfTeam {
    @meta.id
    @db.default.increment
    id: number

    name: string
}

@db.table 'pf_issues'
export interface PfIssue {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    teamId: PfTeam.id
}

@db.table 'pf_paths'
export interface PfPath {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    issueId: PfIssue.id
}

// ── Managed view with an ignored field ───────────────────────────────────

@db.view 'pf_token_list'
@db.view.for PfTokenV1
export interface PfTokenList {
    id: PfTokenV1.id
    label: PfTokenV1.label

    @db.ignore
    computed?: string
}

// ── MySQL: column attributes that a MODIFY must preserve ─────────────────

@db.table 'pf_stamped'
export interface PfStamped {
    @meta.id
    @db.default.increment
    id: number

    @db.default 'draft'
    @db.column.collate 'nocase'
    status: string

    @db.mysql.onUpdate "CURRENT_TIMESTAMP"
    @db.default.now
    updatedAt: number.timestamp

    @db.json
    settings?: {
        theme: string
    }

    location: db.geoPoint

    note?: string

    @db.default 'n/a'
    @db.mysql.type "TEXT"
    remarks: string
}

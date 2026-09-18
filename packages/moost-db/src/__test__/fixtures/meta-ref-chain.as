// Fixture for meta-ref-chain.spec.ts — reference chains whose terminal field
// (the column's value domain) differs from the direct hop.

@db.table 'dicts'
export interface Dict {
    @meta.id
    code: string

    label: string
}

@db.table 'issues'
export interface Issue {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    code: Dict.code

    @db.rel.to
    dict?: Dict
}

// One hop away from the FK: code → Issue.code → Dict.code
@db.view 'issue_view'
@db.view.for Issue
export interface IssueView {
    id: Issue.id
    code: Issue.code
    title: Issue.title
}

// Three hops: x → IssueView.code → Issue.code → Dict.code
export interface Deep {
    x: IssueView.code
}

// A chain that never passes an FK — re-pointed but not marked.
export interface Plain {
    note: Issue.title
}

// Self reference: the PK has no ref, the walk stops immediately.
@db.table 'selfs'
export interface Self {
    @meta.id
    id: number

    @db.rel.FK
    parentId?: Self.id
}

// Action input form declared through the same chain (/meta/form/:name).
export interface RefForm {
    code: Issue.code

    note?: string
}

// Versioned table: `db.column.version` must survive /meta serialization so the
// db-client validator can skip the server-managed version on insert.
@db.table 'versioned_docs'
export interface VersionedDoc {
    @meta.id
    id: number

    title: string

    @db.column.version
    version: number.int

    @db.index.plain
    @db.column 'doc_slug'
    slug: string
}

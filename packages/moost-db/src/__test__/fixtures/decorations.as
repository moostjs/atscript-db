// Fixtures for declared-decorations.spec.ts: a table and plain interfaces
// declaring display-only fields for `@DbDecorations`.

@db.table 'deco_tickets'
export interface DecoTicket {
    @meta.id
    id: number

    title: string

    ownerId: number

    status: string

    @db.writeOnly
    secret: string
}

// A plain interface — no @db.table / @db.view.
export interface DecoTicketDecorations {
    @meta.label 'Unread'
    unreadCount?: number.int

    @meta.label 'Owner'
    ownerName?: string
}

// `title` is a field of DecoTicket.
export interface DecoColliding {
    title?: string
}

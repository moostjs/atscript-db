// Defaults below a tuple or a union of several types are not filled, so such
// a field is required on insert (since 0.1.155) — also for a client that
// validates against `/meta`.
export interface AmbCard {
    kind: 'card'
    at: number.timestamp.created
}

export interface AmbBank {
    kind: 'bank'
    iban: string
}

@db.table 'amb_events'
export interface AmbEvent {
    @meta.id
    id: number

    createdAt: number.timestamp.created

    @db.json
    steps: [{ at: number.timestamp.created }, { note: string }]

    pay: AmbCard | AmbBank
}

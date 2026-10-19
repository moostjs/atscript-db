// String literals MySQL reads with backslash escapes: view filter values
// with a backslash, and a JSON leaf whose key holds a quote.
@db.table 'esc_items'
export interface EscItem {
    @meta.id
    id: number

    code: string

    @db.json
    attrs: {
        "it's": string
        plain: string
    }
}

@db.view 'esc_backslash'
@db.view.for EscItem
@db.view.filter `EscItem.code = 'a\\b'`
export interface EscBackslash {
    id: EscItem.id
    code: EscItem.code
}

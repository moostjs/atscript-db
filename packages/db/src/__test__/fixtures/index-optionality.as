@db.table 'creds'
export interface IndexOptionalityCreds {
    @meta.id
    @db.default.increment
    id: number

    // required unique string
    @db.index.unique 'username_idx'
    username: string

    // optional unique string
    @db.index.unique 'email_idx'
    email?: string.email

    // optional unique number (design type must be carried, not assumed string)
    @db.index.unique 'extid_idx'
    externalId?: number
}

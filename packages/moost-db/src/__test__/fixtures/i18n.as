// Fixture for meta-i18n.spec.ts — texts a translator replaces per request.

@db.table 'i18n_items'
export interface I18nItem {
    @meta.id
    id: number

    @meta.label 'Name'
    @expect.minLength 3, 'Name is too short'
    @db.index.unique 'name_idx'
    name: string

    @meta.label 'Code'
    @expect.maxLength 4
    code?: string
}

export interface I18nReason {
    @meta.label 'Reason'
    @meta.required
    reason: string
}

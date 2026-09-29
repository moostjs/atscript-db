// Views inherit their sources' read seals — @db.writeOnly and @db.encrypted
// (view-seals.spec.ts). Since 0.1.143.

@db.table 'sl_accounts'
export interface SlAccount {
    @meta.id
    id: number

    title: string

    @db.writeOnly
    pin?: string

    @db.encrypted
    token?: string

    @db.writeOnly
    secrets: {
        apiKey: string
        hint: string
    }

    profile: {
        @db.writeOnly
        recovery: string
        theme: string
    }

    salary: number

    @db.writeOnly
    note?: string
}

@db.view 'sl_account_view'
@db.view.for SlAccount
export interface SlAccountView {
    id: SlAccount.id
    title: SlAccount.title
    pin?: SlAccount.pin
    token?: SlAccount.token
    apiKey: SlAccount.secrets.apiKey
    recovery: SlAccount.profile.recovery
    theme: SlAccount.profile.theme
    profile: SlAccount.profile
    salary: number
    note?: string
}

// A view over a view: the seal travels through the intermediate view.
@db.view 'sl_view_over_view'
@db.view.for SlAccountView
export interface SlViewOverView {
    id: SlAccountView.id
    pinAgain?: SlAccountView.pin
    tokenAgain?: SlAccountView.token
    title: SlAccountView.title
}

@db.view 'sl_totals'
@db.view.for SlAccount
export interface SlTotals {
    title: SlAccount.title

    @db.agg.count
    n: number

    @db.agg.max "pin"
    maxPin?: string
}

@db.view 'sl_bad_agg'
@db.view.for SlAccount
export interface SlBadAgg {
    title: SlAccount.title

    @db.agg.max "token"
    maxToken?: string
}

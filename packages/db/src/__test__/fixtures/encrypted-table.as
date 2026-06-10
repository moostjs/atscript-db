@db.table 'enc_partners'
export interface EncPartner {
    @meta.id
    id: string

    legalName: string

    @db.encrypted
    apiToken?: string

    @db.encrypted
    creditCredentials?: {
        user: string
        pwd: string
    }

    @db.encrypted
    pinCode?: number

    @db.encrypted
    isVip?: boolean

    @db.encrypted
    tags?: string[]
}

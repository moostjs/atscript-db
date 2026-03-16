@db.table '__atscript_control'
export interface AtscriptControl {
    @meta.id
    _id: string

    value?: string

    lockedBy?: string

    lockedAt?: number

    expiresAt?: number
}

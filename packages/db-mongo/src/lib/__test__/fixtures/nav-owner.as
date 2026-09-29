// Cross-file navigation target for nav-props.as (nav subfields are not columns).

@db.table 'nv_owners'
export interface NvOwner {
    @meta.id
    id: number

    name: string

    address: {
        city: string
    }
}

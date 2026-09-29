// Navigation properties (@db.rel.to / @db.rel.from) on a document adapter: the
// nav fields and their subfields are never stored columns — schema sync must
// not plan, backfill or unset them.
import { NvOwner } from './nav-owner'

@db.table 'nv_accounts'
export interface NvAccount {
    @meta.id
    id: number

    label: string

    @db.rel.FK
    ownerId: NvOwner.id

    // cross-file nav (object)
    @db.rel.to
    owner?: NvOwner

    // same-file nav (array)
    @db.rel.from
    cards?: NvCard[]
}

@db.table 'nv_cards'
export interface NvCard {
    @meta.id
    id: number

    @db.rel.FK
    accountId: NvAccount.id

    @db.default 'active'
    status: string

    // same-file nav (object)
    @db.rel.to
    account?: NvAccount
}

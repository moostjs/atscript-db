@db.table 'up_items'
export interface UpItem {
    @meta.id
    id: number

    name: string

    @db.default '10000'
    cap: number

    note?: string

    @db.default.now
    createdAt?: number.timestamp.created

    @db.patch.strategy 'merge'
    stats?: {
        views?: number
        rating?: number
    }

    address?: {
        city?: string
        line2?: string
    }
}

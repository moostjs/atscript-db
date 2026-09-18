@db.table 'ws_items'
export interface WsItem {
    @meta.id
    id: number

    name: string

    @db.default '10000'
    cap?: number

    note?: string

    counter?: number

    address?: {
        city: string
        line2?: string
    }

    @db.patch.strategy 'merge'
    stats?: {
        views: number
        rating?: number
    }

    @db.json
    payload?: {
        a?: string
        items?: {
            x?: number
            y?: string
        }[]
    }
}

// Array patch operators on arrays inside nested objects (since 0.1.182 on the
// in-memory adapter): every depth, both patch strategies of the parents.

@db.table 'nao_items'
export interface NaoItem {
    @meta.id
    id: number

    box?: {
        caption?: string
        labels?: string[]
    }

    @db.patch.strategy 'merge'
    mbox?: {
        caption?: string
        labels?: string[]
    }

    outer?: {
        title?: string
        inner?: {
            note?: string
            labels?: string[]
        }
        @db.patch.strategy 'merge'
        minner?: {
            note?: string
            labels?: string[]
        }
    }

    @db.patch.strategy 'merge'
    mouter?: {
        inner?: {
            note?: string
            lines?: {
                @expect.array.key
                k: string
                v: number
            }[]
        }
    }
}

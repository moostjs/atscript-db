// A merge-strategy object inside a replaced (default-strategy) one, at
// several depths: the merge object keeps the children the patch leaves out,
// on every adapter (since 0.1.183; before, the SQL and in-memory adapters
// cleared them). Merge-strategy objects stored as `null` take a patch on
// every write path too (MongoDB `updateMany` threw before 0.1.183).

@db.table 'mir_items'
export interface MirItem {
    @meta.id
    id: number

    label?: string

    // replace > merge
    outer?: {
        a?: string
        @db.patch.strategy 'merge'
        inner?: {
            x?: string
            y?: string
            tags?: string[]
        }
    }

    // merge > replace > merge
    @db.patch.strategy 'merge'
    mtop?: {
        c?: string
        mid?: {
            b?: string
            @db.patch.strategy 'merge'
            leaf?: {
                x?: string
                y?: string
            }
        }
    }

    // replace > merge > replace
    rtop?: {
        a?: string
        @db.patch.strategy 'merge'
        mid?: {
            k?: string
            leaf?: {
                x?: string
                y?: string
            }
        }
    }

    // replace > replace > merge
    deep?: {
        b?: string
        r?: {
            a?: string
            @db.patch.strategy 'merge'
            m?: {
                x?: string
                y?: string
            }
        }
    }

    // merge > merge
    @db.patch.strategy 'merge'
    mm?: {
        c?: string
        n?: number
        @db.patch.strategy 'merge'
        inner?: {
            x?: string
            y?: string
        }
    }

    // replace > a required merge object with a required child
    req?: {
        a?: string
        @db.patch.strategy 'merge'
        inner: {
            x: string
            y?: string
        }
    }
}

@db.table 'noDepthTargets'
export interface NoDepthTarget {
    @meta.id
    @db.default.increment
    id: number

    name: string

    score?: number
}

import { NoDepthTarget } from './rel-no-depth-target'

@db.table 'noDepthMiddles'
@db.depth.limit 2
export interface NoDepthMiddle {
    @meta.id
    @db.default.increment
    id: number

    label: string

    @db.rel.FK
    targetId?: NoDepthTarget.id

    @db.rel.to
    target?: NoDepthTarget
}

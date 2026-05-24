import { NoDepthMiddle } from './rel-no-depth-middle'
import { NoDepthTarget } from './rel-no-depth-target'

@db.table 'noDepthSources'
@db.depth.limit 2
export interface NoDepthSource {
    @meta.id
    @db.default.increment
    id: number

    title: string

    @db.rel.FK
    middleId?: NoDepthMiddle.id

    @db.rel.FK
    targetId?: NoDepthTarget.id

    // rel.to Middle — visited first, recurses into NoDepthTarget via middle.target
    @db.rel.to
    middle?: NoDepthMiddle

    // rel.to Target — by the time we get here, NoDepthTarget is in visitedIds
    // (added transitively via middle.target), so flattenAnnotatedType skips
    // recursion into target.* — reproducing the upstream asymmetry.
    @db.rel.to
    target?: NoDepthTarget
}

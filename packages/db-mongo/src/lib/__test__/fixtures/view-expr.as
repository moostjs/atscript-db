// First-row joins and computed view columns on a real engine (view-expr.spec.ts).
// Since 0.1.147. The same fixture is shared by db-mysql / db-postgres.

@db.table 'vx_reporters'
export interface VxReporter {
    @meta.id
    id: number
    name: string
}

@db.table 'vx_tickets'
export interface VxTicket {
    @meta.id
    id: number
    title: string
}

@db.table 'vx_issues'
export interface VxIssue {
    @meta.id
    id: number
    ticketId: number
    reporterId?: number
    @db.column 'raised_at'
    raisedAt?: number
    severity: number
    status: string
    overdue: boolean
    estimate?: number
    @db.json
    meta?: { level: number }
}

@db.alias VxIssue
export type VxOldest = VxIssue

@db.alias VxIssue
export type VxNewest = VxIssue

@db.alias VxIssue
export type VxEarliest = VxIssue

// Grouped: counts over the regular join, the oldest OPEN issue (ties → lowest
// id, NULL raisedAt first), its reporter (chained join) and computed columns.
@db.view 'vx_queue'
@db.view.for VxTicket
@db.view.joins VxIssue, `VxIssue.ticketId = VxTicket.id`, 'left'
@db.view.joins VxOldest, `VxOldest.ticketId = VxTicket.id and VxOldest.status = 'open'`, 'left', `raisedAt`
@db.view.joins VxReporter, `VxReporter.id = VxOldest.reporterId`, 'left'
export interface VxQueue {
    id: VxTicket.id
    title: VxTicket.title

    @db.agg.count 'id', `VxIssue.status = 'open'`
    openCount: VxIssue.id

    @db.agg.count 'id', `VxIssue.status = 'open' and VxIssue.overdue = true`
    overdueCount: VxIssue.id

    @db.agg.sum 'estimate', `VxIssue.status = 'open'`
    openEstimate?: VxIssue.estimate

    oldestId?: VxOldest.id
    oldestRaisedAt?: VxOldest.raisedAt
    oldestSeverity?: VxOldest.severity
    reporterName?: VxReporter.name

    @db.compute `openCount * 10 + overdueCount`
    rank: number

    @db.compute `openEstimate / openCount`
    avgEstimate?: number

    @db.compute `coalesce(oldestSeverity, 0) * 100 + rank`
    priority: number

    @db.compute `-(openCount - overdueCount) * 2`
    negDiff: number

    @db.compute `openCount - -1`
    plusOne: number
}

// HAVING on a computed column
@db.view 'vx_busy'
@db.view.for VxTicket
@db.view.joins VxIssue, `VxIssue.ticketId = VxTicket.id`, 'left'
@db.view.having `rank > 0`
export interface VxBusy {
    id: VxTicket.id

    @db.agg.count 'id', `VxIssue.status = 'open'`
    openCount: VxIssue.id

    @db.compute `openCount * 10`
    rank: number
}

// Inner first-row join, descending: the newest issue (NULL last), tickets without issues dropped
@db.view 'vx_latest'
@db.view.for VxTicket
@db.view.joins VxNewest, `VxNewest.ticketId = VxTicket.id`, 'inner', `raisedAt desc`
export interface VxLatest {
    id: VxTicket.id
    newestId: VxNewest.id
    newestRaisedAt?: VxNewest.raisedAt
}

// Unfiltered first row: a NULL order key is the smallest value
@db.view 'vx_earliest'
@db.view.for VxTicket
@db.view.joins VxEarliest, `VxEarliest.ticketId = VxTicket.id`, 'left', `raisedAt, severity desc`
export interface VxEarliest2 {
    id: VxTicket.id
    earliestId?: VxEarliest.id
}

// Per-row computed columns (no aggregates)
@db.view 'vx_ratio'
@db.view.for VxIssue
export interface VxRatio {
    id: VxIssue.id
    severity: VxIssue.severity
    estimate?: VxIssue.estimate

    @db.compute `coalesce(estimate, 0) * severity`
    weight: number

    @db.compute `severity / 2`
    half?: number

    @db.compute `severity / estimate`
    perEstimate?: number
}

// A view over a view reading (and sorting on) a computed column
@db.view 'vx_ranked'
@db.view.for VxQueue
@db.view.filter `rank > 0`
export interface VxRanked {
    id: VxQueue.id
    rank: VxQueue.rank
    priority: VxQueue.priority
}

// A computed column over a JSON-extracted GROUP BY dimension
@db.view 'vx_levels'
@db.view.for VxIssue
export interface VxLevels {
    level?: VxIssue.meta.level

    @db.agg.count
    n: number

    @db.compute `coalesce(level, 0) * 2 + n`
    score: number
}

// HAVING on a computed column whose name equals a grouped source column
// (`severity`): MySQL would bind a bare `severity` to the GROUP BY column.
@db.view 'vx_collide'
@db.view.for VxIssue
@db.view.having `severity = 2`
export interface VxCollide {
    sev: VxIssue.severity

    @db.agg.count
    n: number

    @db.compute `n * 2`
    severity: number
}

// Computed columns evaluate in double: an int64 operand past 2^53 rounds
// like on the SQL adapters instead of staying exact
@db.table 'vx_big'
export interface VxBig {
    @meta.id
    id: number
    n: number
    m: number
}

@db.view 'vx_big_calc'
@db.view.for VxBig
export interface VxBigCalc {
    id: VxBig.id
    n: VxBig.n
    m: VxBig.m

    @db.compute `n + 1`
    plus: number

    @db.compute `n - m`
    diff: number
}

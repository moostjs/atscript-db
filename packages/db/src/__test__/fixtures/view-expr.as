// First-row joins and computed view columns (view-expr.spec.ts). Since 0.1.147.

@db.table 've_tickets'
export interface VeTicket {
    @meta.id
    id: number
    title: string
}

@db.table 've_issues'
export interface VeIssue {
    @meta.id
    id: number
    ticketId: number
    @db.column 'raised_at'
    raisedAt: number
    severity: number
    status: string
    overdue: boolean
    estimate?: number
    @db.writeOnly
    cost?: number
}

@db.table 've_vaults'
export interface VeVault {
    @meta.id
    id: number
    @db.encrypted
    secretScore?: number
}

@db.alias VeIssue
export type VeOldest = VeIssue

@db.alias VeIssue
export type VeNewest = VeIssue

@db.view 've_queue'
@db.view.for VeTicket
@db.view.joins VeIssue, `VeIssue.ticketId = VeTicket.id`, 'left'
@db.view.joins VeOldest, `VeOldest.ticketId = VeTicket.id and VeOldest.status = 'open'`, 'left', `raisedAt`
export interface VeQueue {
    id: VeTicket.id
    title: VeTicket.title

    @db.agg.count 'id', `VeIssue.status = 'open'`
    openCount: VeIssue.id

    @db.agg.count 'id', `VeIssue.status = 'open' and VeIssue.overdue = true`
    overdueCount: VeIssue.id

    @db.agg.sum 'estimate', `VeIssue.status = 'open'`
    openEstimate?: VeIssue.estimate

    oldestRaisedAt?: VeOldest.raisedAt
    oldestSeverity?: VeOldest.severity

    @db.compute `openCount * 10 + overdueCount`
    rank: number

    @db.compute `openEstimate / openCount`
    avgEstimate?: number

    @db.compute `coalesce(oldestSeverity, 0) * 100 + rank`
    priority: number
}

// Order key already the primary key (not appended twice); a desc key
@db.view 've_latest'
@db.view.for VeTicket
@db.view.joins VeNewest, `VeNewest.ticketId = VeTicket.id`, 'inner', `raisedAt desc, id`
export interface VeLatest {
    id: VeTicket.id
    newestId: VeNewest.id
    newestRaisedAt: VeNewest.raisedAt
}

// Per-row computed columns (no aggregates)
@db.view 've_issue_cost'
@db.view.for VeIssue
export interface VeIssueCost {
    id: VeIssue.id
    severity: VeIssue.severity
    estimate?: VeIssue.estimate
    cost?: VeIssue.cost

    @db.compute `coalesce(estimate, 0) * severity`
    weight: number

    @db.compute `cost * 2`
    doubleCost?: number

    @db.compute `doubleCost + weight`
    total?: number
}

// An encrypted operand is rejected at first use
@db.view 've_secret'
@db.view.for VeVault
export interface VeSecret {
    id: VeVault.id
    secretScore?: VeVault.secretScore

    @db.compute `secretScore + 1`
    bumped?: number
}

// Hash variants (same shape, one difference each)

@db.view 've_h_base'
@db.view.for VeTicket
@db.view.joins VeOldest, `VeOldest.ticketId = VeTicket.id`, 'left', `raisedAt`
export interface VeHBase {
    id: VeTicket.id
    oldestSeverity?: VeOldest.severity
    oldestRaisedAt?: VeOldest.raisedAt

    @db.compute `oldestSeverity * 2`
    score?: number
}

@db.view 've_h_same'
@db.view.for VeTicket
@db.view.joins VeOldest, `VeOldest.ticketId = VeTicket.id`, 'left', `raisedAt`
export interface VeHSame {
    id: VeTicket.id
    oldestSeverity?: VeOldest.severity
    oldestRaisedAt?: VeOldest.raisedAt

    @db.compute `oldestSeverity * 2`
    score?: number
}

@db.view 've_h_desc'
@db.view.for VeTicket
@db.view.joins VeOldest, `VeOldest.ticketId = VeTicket.id`, 'left', `raisedAt desc`
export interface VeHDesc {
    id: VeTicket.id
    oldestSeverity?: VeOldest.severity
    oldestRaisedAt?: VeOldest.raisedAt

    @db.compute `oldestSeverity * 2`
    score?: number
}

@db.view 've_h_key'
@db.view.for VeTicket
@db.view.joins VeOldest, `VeOldest.ticketId = VeTicket.id`, 'left', `severity`
export interface VeHKey {
    id: VeTicket.id
    oldestSeverity?: VeOldest.severity
    oldestRaisedAt?: VeOldest.raisedAt

    @db.compute `oldestSeverity * 2`
    score?: number
}

@db.view 've_h_expr'
@db.view.for VeTicket
@db.view.joins VeOldest, `VeOldest.ticketId = VeTicket.id`, 'left', `raisedAt`
export interface VeHExpr {
    id: VeTicket.id
    oldestSeverity?: VeOldest.severity
    oldestRaisedAt?: VeOldest.raisedAt

    @db.compute `oldestSeverity * 3`
    score?: number
}

@db.view 've_h_operand'
@db.view.for VeTicket
@db.view.joins VeOldest, `VeOldest.ticketId = VeTicket.id`, 'left', `raisedAt`
export interface VeHOperand {
    id: VeTicket.id
    oldestSeverity?: VeOldest.severity
    oldestRaisedAt?: VeOldest.raisedAt

    @db.compute `oldestRaisedAt * 2`
    score?: number
}

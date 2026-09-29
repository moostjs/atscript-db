// Fixture for meta-view-chain.spec.ts — /meta over a view that reads another
// view and over a view with @db.alias joins (since 0.1.141).

@db.table 'mc_dicts'
export interface McDict {
    @meta.id
    code: string

    label: string
}

@db.table 'mc_issues'
export interface McIssue {
    @meta.id
    id: number

    title: string
    parentId?: number

    @db.rel.FK
    code: McDict.code
}

@db.view 'mc_issue_view'
@db.view.for McIssue
export interface McIssueView {
    id: McIssue.id
    code: McIssue.code
    title: McIssue.title
}

// A view over the view: code → McIssueView.code → McIssue.code → McDict.code
@db.view 'mc_issue_chain'
@db.view.for McIssueView
@db.view.filter `McIssueView.title != ''`
export interface McIssueChain {
    id: McIssueView.id
    code: McIssueView.code
    title: McIssueView.title
}

@db.alias McIssue
export type McParent = McIssue

@db.view 'mc_issue_parents'
@db.view.for McIssue
@db.view.joins McParent, `McParent.id = McIssue.parentId`, 'left'
export interface McIssueParents {
    id: McIssue.id
    title: McIssue.title
    parentTitle?: McParent.title
    parentCode?: McParent.code
}

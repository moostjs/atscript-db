// Plain (non-table) WF-form-style interface carrying @db.rel.FK
// fields. These would have failed F1 before this change; the
// relaxation is the reason they compile now.

import { Role } from './roles-table'
import { StatusDict } from './status-dict'

export interface InviteForm {
    email: string

    // FK to a @db.table target (DB-backed value help).
    @db.rel.FK
    roleId: Role.id

    // FK to a plain value-help dictionary target.
    @db.rel.FK
    status: StatusDict.id
}

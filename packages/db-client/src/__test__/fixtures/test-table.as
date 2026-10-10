@db.table "users"
export interface User {
  @meta.id
  @db.default.increment
  id: number

  name: string

  email?: string

  @db.default "active"
  status: string

  @db.patch.strategy "merge"
  credit?: {
    provider: string
    status: 'none' | 'pending' | 'active' | 'failed'
    note?: string
    credentials?: {
      account: string
      password: string
    }
  }

  profile?: {
    bio: string
    age?: number
  }
}

@db.table "versioned_users"
export interface VersionedUser {
  @meta.id
  @db.default.increment
  id: number

  name: string

  @db.column.version
  version: number
}

@db.table 'versioned_revisions'
export interface VersionedRevision {
  @meta.id
  @db.default.increment
  id: number

  name: string

  @db.column 'rev'
  @db.column.version
  revision: number
}

// @db.column.derived — scalar columns computed from a @db.json leaf.
@db.table 'derived_orders'
export interface DerivedOrder {
  @meta.id
  id: number

  status: string

  @db.json
  payload: {
    customer: {
      id: string
    }
    total: number
  }

  @db.column.derived
  @db.index.plain
  customerId: DerivedOrder.payload.customer.id

  @db.column.derived
  amount: DerivedOrder.payload.total
}

@db.table 'created_rows'
export interface CreatedRow {
  @meta.id
  id: number

  createdAt: number.timestamp.created

  closedAt: number.timestamp.created | null

  stamp: number.timestamp.created | string

  audit: {
    at: number.timestamp.created
  }
}

@db.table 'updated_rows'
export interface UpdatedRow {
  @meta.id
  id: number

  updatedAt: number.timestamp.updated

  closedAt: number.timestamp.updated | null

  audit: {
    at: number.timestamp.updated
  }

  @db.onUpdate.now
  editedAt: number.timestamp
}

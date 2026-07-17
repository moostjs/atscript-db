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

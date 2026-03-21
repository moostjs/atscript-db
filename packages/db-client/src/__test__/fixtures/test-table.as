@db.table "users"
export interface User {
  @meta.id
  @db.default.increment
  id: number

  name: string

  email?: string

  @db.default "active"
  status: string
}

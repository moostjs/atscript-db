@db.table "mf_users"
export interface MfUser {
  @meta.id
  id: string
}

@db.view "mf_active_users"
export interface MfActiveUser {
  id: string
}

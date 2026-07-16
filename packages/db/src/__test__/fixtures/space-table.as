@db.table "analytics_events"
@db.space "analytics"
export interface AnalyticsEvent {
  @meta.id
  id: string

  name: string
}

@db.table "app_users_default_space"
export interface DefaultSpaceUser {
  @meta.id
  id: string
}

@db.table "mf_events"
@db.space "analytics"
export interface MfEvent {
  @meta.id
  id: string
}

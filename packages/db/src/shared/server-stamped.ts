/**
 * The annotations whose field the server writes on every update — the write
 * sets `@db.onUpdate.now` to the current time and increments
 * `@db.onUpdate.inc` — so a client value is overwritten (now) or dropped
 * (inc). Dependency-free: UI and plugin code can import it from
 * `@atscript/db/validator` without pulling the compiler into a bundle.
 * @since 0.1.163
 */
export const SERVER_STAMPED_ON_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "db.onUpdate.now",
  "db.onUpdate.inc",
]);

/**
 * Whether a field's metadata marks it as stamped by the server on every
 * update (`@db.onUpdate.now` or `@db.onUpdate.inc`) — e.g. to render it
 * read-only in an edit form.
 * @since 0.1.163
 */
export function isServerStampedOnUpdate(metadata: { has(key: string): boolean }): boolean {
  for (const key of SERVER_STAMPED_ON_UPDATE_KEYS) {
    if (metadata.has(key)) return true;
  }
  return false;
}

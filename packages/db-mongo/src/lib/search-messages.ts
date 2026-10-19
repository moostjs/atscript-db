/**
 * The refusal of `@db.mongo.search.dynamic` on a collection storing an
 * `@db.encrypted` field (at `path`) — shared by the compile-time check and
 * its runtime mirror.
 */
export function dynamicSearchEncryptedMessage(path: string): string {
  return `@db.mongo.search.dynamic indexes every field, including the @db.encrypted field "${path}" — Atlas Search over ciphertext is impossible; use @db.mongo.search.static with @db.mongo.search.text fields`;
}

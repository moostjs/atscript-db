import { DbSpace } from "@atscript/db";
import { MongoClient } from "mongodb";

import { MongoAdapter } from "./mongo-adapter";

export * from "./mongo-adapter";
export * from "./mongo-filter";
export * from "./collection-patcher";
export * from "./validate-plugins";

export function createAdapter(connection: string, _options?: Record<string, unknown>): DbSpace {
  const client = new MongoClient(connection);
  const db = client.db();
  return new DbSpace(() => new MongoAdapter(db, client));
}

import { DbSpace } from "@atscript/db";
import { MongoClient } from "mongodb";

import { MongoAdapter, type TMongoAdapterOptions } from "./mongo-adapter";

export * from "./mongo-adapter";
export * from "./mongo-filter";
export * from "./collection-patcher";
export * from "./validate-plugins";

/** A {@link DbSpace} over the database of `connection`; `options` go to every {@link MongoAdapter}. */
export function createAdapter(connection: string, options?: TMongoAdapterOptions): DbSpace {
  const client = new MongoClient(connection);
  const db = client.db();
  return new DbSpace(() => new MongoAdapter(db, client, options), {
    onClose: () => client.close(),
  });
}

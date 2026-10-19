import type { Document, MongoClient } from "mongodb";
import { MongoServerError } from "mongodb";

import { COMMAND_NOT_FOUND } from "./mongo-errors";

const verdicts = new WeakMap<MongoClient, Promise<boolean>>();

/** Whether the client's server runs transactions, asked once per client; a failed probe is retried. */
export function transactionSupport(client: MongoClient): Promise<boolean> {
  let verdict = verdicts.get(client);
  if (!verdict) {
    verdict = probe(client).catch((error: unknown) => {
      verdicts.delete(client);
      throw error;
    });
    verdicts.set(client, verdict);
  }
  return verdict;
}

/**
 * A replica-set member reports `setName` (an uninitiated `--replSet` member
 * `isreplicaset: true`), a mongos — also behind a load balancer —
 * `msg: 'isdbgrid'`. Anything else is a standalone `mongod`.
 */
async function probe(client: MongoClient): Promise<boolean> {
  const admin = client.db("admin");
  let reply: Document;
  try {
    reply = await admin.command({ hello: 1 });
  } catch (error) {
    // The driver supports servers from 4.2; 4.2.0–4.2.9 have no `hello`.
    if (!(error instanceof MongoServerError) || error.code !== COMMAND_NOT_FOUND) {
      throw error;
    }
    reply = await admin.command({ isMaster: 1 });
  }
  return reply.setName != null || reply.isreplicaset === true || reply.msg === "isdbgrid";
}

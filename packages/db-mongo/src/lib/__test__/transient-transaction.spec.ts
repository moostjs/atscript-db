import { describe, expect, it } from "vite-plus/test";
import { DbError } from "@atscript/db";
import { MongoServerError } from "mongodb";

import { MongoAdapter } from "../mongo-adapter";

// `session.withTransaction` retries a transient conflict for 120 s, then
// rethrows the raw driver error; the adapter surfaces it as the retryable
// `SERIALIZATION_FAILURE` (raw error as `cause`).

function adapterFailingWith(error: unknown): MongoAdapter {
  const client = {
    db: () => ({ command: async () => ({ setName: "rs" }) }),
    startSession: () => ({
      withTransaction: async () => {
        throw error;
      },
      endSession: async () => {},
    }),
  };
  return new MongoAdapter({} as never, client as never);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

function labelled(label: string, code?: number): MongoServerError {
  const error = new MongoServerError({ message: `driver: ${label}`, code });
  error.addErrorLabel(label);
  return error;
}

describe("[mongo] transient transaction errors", () => {
  it.each([
    ["TransientTransactionError", 112],
    ["UnknownTransactionCommitResult", undefined],
  ])(
    "%s becomes a retryable SERIALIZATION_FAILURE with the driver error as cause",
    async (label, code) => {
      const raw = labelled(label, code);
      const error = await rejection(adapterFailingWith(raw).withTransaction(async () => {}));
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe("SERIALIZATION_FAILURE");
      expect((error as DbError).retryable).toBe(true);
      expect((error as DbError).cause).toBe(raw);
    },
  );

  it("an unlabelled WriteConflict (code 112) is mapped too", async () => {
    const raw = new MongoServerError({ message: "write conflict", code: 112 });
    const error = await rejection(adapterFailingWith(raw).withTransaction(async () => {}));
    expect((error as DbError).code).toBe("SERIALIZATION_FAILURE");
  });

  it("other errors and DbErrors pass through unchanged", async () => {
    const other = new MongoServerError({ message: "boom", code: 8000 });
    expect(await rejection(adapterFailingWith(other).withTransaction(async () => {}))).toBe(other);
    const db = new DbError("CONFLICT", [{ path: "", message: "dup" }]);
    expect(await rejection(adapterFailingWith(db).withTransaction(async () => {}))).toBe(db);
  });
});

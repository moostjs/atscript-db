import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { describe, expect, it } from "vite-plus/test";

import dbPlugin from "../plugin";
import { DERIVED_INCOMPATIBLE } from "../shared/derived-rules";

// Compile-time diagnostics of `@db.column.derived` (rules D1–D10 of the
// derived-column design, since 0.1.141).

const TABLES = `
@db.table 'da_customers'
export interface DaCustomer {
    @meta.id
    id: number
    name: string
}
`;

async function diagnosticsFor(
  source: string,
): Promise<Array<{ message: string; severity: number }>> {
  const rootDir = mkdtempSync(join(tmpdir(), "derived-annotations-"));
  writeFileSync(join(rootDir, "fixture.as"), TABLES + source);
  const repo = await build({
    rootDir,
    entries: ["fixture.as"],
    plugins: [tsPlugin(), dbPlugin()],
  });
  const diagnostics = await repo.diagnostics();
  return [...diagnostics.values()]
    .flat()
    .map((message) => ({ message: message.message, severity: message.severity }));
}

const messagesOf = async (source: string) => (await diagnosticsFor(source)).map((m) => m.message);

/** An orders table with a JSON payload and one derived field declared as `field`. */
const orders = (field: string, extraProps = "") => `
@db.table 'da_orders'
export interface DaOrder {
    @meta.id
    id: number

    @db.json
    payload: {
        customer: {
            id: string
            vip: boolean
            tags: string[]
            since?: number
        }
        total: number
        lines: { sku: string }[]
        settings?: {
            theme: string
        }
    }

    address: {
        city: string
    }

    @db.encrypted
    @db.json
    secret?: {
        token: string
    }
${extraProps}
${field}
}
`;

describe("@db.column.derived — accepted declarations", () => {
  it("compiles a string / number / boolean leaf inside a @db.json field, with the allowed companions", async () => {
    const messages = await messagesOf(
      orders(`
    @db.column.derived
    @db.index.plain
    @db.column.dimension
    @db.column.filterable
    @db.column.sortable
    @db.column.searchable
    @db.column.collate 'nocase'
    @db.column 'customer_id'
    @expect.maxLength 64
    customerId: DaOrder.payload.customer.id

    @db.column.derived
    @db.index.unique
    vip: DaOrder.payload.customer.vip

    @db.column.derived
    @db.column.measure
    @db.column.renamed 'amount'
    total: DaOrder.payload.total
`),
    );
    expect(messages).toEqual([]);
  });

  it("D9: an optional path only warns when the field is not optional", async () => {
    const strict = await diagnosticsFor(
      orders(`
    @db.column.derived
    theme: DaOrder.payload.settings.theme
`),
    );
    expect(strict).toEqual([
      {
        message:
          "@db.column.derived path 'DaOrder.payload.settings.theme' may be absent — declare the field optional (`theme?:`) so a missing leaf reads as null",
        severity: 2,
      },
    ]);
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    theme?: DaOrder.payload.settings.theme
`),
      ),
    ).toEqual([]);
    // The leaf itself optional counts too
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    since: DaOrder.payload.customer.since
`),
      ),
    ).toEqual([
      "@db.column.derived path 'DaOrder.payload.customer.since' may be absent — declare the field optional (`since?:`) so a missing leaf reads as null",
    ]);
  });
});

describe("@db.column.derived — rejected declarations", () => {
  it("D1: only a top-level field of a @db.table", async () => {
    expect(
      await messagesOf(
        orders(`
    nested: {
        @db.column.derived
        customerId: DaOrder.payload.customer.id
    }
`),
      ),
    ).toContain("@db.column.derived is only valid on a top-level field of a @db.table interface");
    expect(
      await messagesOf(`
export interface DaPlain {
    @db.json
    payload: { x: string }

    @db.column.derived
    x: DaPlain.payload.x
}
`),
    ).toContain("@db.column.derived is only valid on a top-level field of a @db.table interface");
  });

  it("D2: the type must be a chain reference", async () => {
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    customerId: string
`),
      ),
    ).toContain(
      "@db.column.derived requires a chain reference into a @db.json field of the same table (e.g. `customerId: Order.payload.customer.id`)",
    );
  });

  it("D3: the reference must name the enclosing table", async () => {
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    customerName: DaCustomer.name
`),
      ),
    ).toContain(
      "@db.column.derived must reference the enclosing table 'DaOrder', not 'DaCustomer' — a derived column reads its own row",
    );
  });

  it("D4: the path must read inside a @db.json field", async () => {
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    city: DaOrder.address.city
`),
      ),
    ).toContain(
      "@db.column.derived path 'DaOrder.address.city' does not read inside a @db.json field — a flattened or scalar column needs no derived column",
    );
    // The JSON field itself is not a leaf inside it
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    copy: DaOrder.payload
`),
      ),
    ).toContain(
      "@db.column.derived path 'DaOrder.payload' does not read inside a @db.json field — a flattened or scalar column needs no derived column",
    );
  });

  it("D5: the path may not cross an array", async () => {
    // Stepping through an array is already a compiler error
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    sku: DaOrder.payload.lines.sku
`),
      ),
    ).toEqual(['Unknown member "sku"']);
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    tags: DaOrder.payload.customer.tags
`),
      ),
    ).toContain(
      "@db.column.derived path 'DaOrder.payload.customer.tags' crosses an array — a derived column reads one scalar leaf",
    );
  });

  it("D6: the leaf must be a string, number or boolean", async () => {
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    customer: DaOrder.payload.customer
`),
      ),
    ).toContain(
      "@db.column.derived path 'DaOrder.payload.customer' must end at a string, number or boolean leaf",
    );
  });

  it("D7: the path may not read inside a @db.encrypted field", async () => {
    expect(
      await messagesOf(
        orders(`
    @db.column.derived
    token?: DaOrder.secret.token
`),
      ),
    ).toContain(
      "@db.column.derived path 'DaOrder.secret.token' reads inside a @db.encrypted field — ciphertext cannot be extracted",
    );
  });

  // D8 — one case per entry of the shared list (the runtime mirror in
  // TableMetadata reads the same list, so neither can drift from the other)
  const D8_ARGS: Record<string, string> = { "db.default": " 'x'", "db.search.vector": " 3" };
  it.each(DERIVED_INCOMPATIBLE)("D8: cannot coexist with @%s", async (name, why) => {
    const messages = await messagesOf(
      orders(`
    @db.column.derived
    @${name}${D8_ARGS[name] ?? ""}
    customerId: DaOrder.payload.customer.id
`),
    );
    expect(messages).toContain(`@db.column.derived cannot coexist with @${name} — ${why}`);
  });
});

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

/**
 * `Mysql2Driver` strict mode (since 0.1.148): every connection the pool opens
 * gets `STRICT_TRANS_TABLES` appended to its session `sql_mode`; `strictMode:
 * false` opts out. Mock `mysql2/promise` — the live counterpart is
 * `mysql2-driver-strict.live.spec.ts`.
 */

const listeners: Array<(conn: unknown) => void> = [];
const acquireListeners: Array<(conn: unknown) => void> = [];
const createPool = vi.fn((_opts: unknown) => ({
  on: (event: string, cb: (conn: unknown) => void) => {
    if (event === "connection") listeners.push(cb);
    if (event === "acquire") acquireListeners.push(cb);
  },
  end: async () => {},
}));
vi.mock("mysql2/promise", () => ({ default: { createPool }, createPool }));

import { Mysql2Driver, ENSURE_STRICT_SQL } from "../mysql2-driver";

/** The options the driver passes to the pools it creates, `typeCast` included. */
const driverPoolOptions = async (): Promise<any> => {
  await new Mysql2Driver("mysql://u@h/db").close();
  return createPool.mock.calls.at(-1)![0];
};

/** A typeCast field as mysql2 builds it: `string()` warns when the encoding asked for equals the reported one. */
function jsonField(reported: "binary" | "utf8", text: string | null) {
  const bytes = text === null ? null : Buffer.from(text, "utf8");
  return {
    type: "JSON",
    name: "payload",
    string(encoding: string = reported) {
      if (encoding === reported) {
        console.warn(`typeCast: JSON column "payload" is interpreted as BINARY by default`);
      }
      return bytes === null ? null : bytes.toString(encoding as BufferEncoding);
    },
    buffer: () => bytes,
  };
}

const open = () => {
  const queries: string[] = [];
  for (const cb of listeners)
    cb({ query: (sql: string, done: () => void) => (queries.push(sql), done()) });
  return queries;
};

beforeEach(() => {
  listeners.length = 0;
  acquireListeners.length = 0;
  createPool.mockClear();
});

describe("Mysql2Driver strictMode", () => {
  it("runs the sql_mode SET on every new connection (URI form)", async () => {
    const driver = new Mysql2Driver("mysql://u@h/db");
    await driver.close();
    expect(open()).toEqual([ENSURE_STRICT_SQL]);
    expect(ENSURE_STRICT_SQL).toContain("STRICT_TRANS_TABLES");
    // appends to the server's modes instead of replacing them
    expect(ENSURE_STRICT_SQL).toContain("@@SESSION.sql_mode");
  });

  it("covers pool-options and pre-created pools too", async () => {
    await new Mysql2Driver({ host: "h" }).close();
    expect(open()).toEqual([ENSURE_STRICT_SQL]);
    listeners.length = 0;
    const pool = {
      execute() {},
      on: (e: string, cb: (c: unknown) => void) => e === "connection" && listeners.push(cb),
    };
    new Mysql2Driver(pool as never);
    expect(open()).toEqual([ENSURE_STRICT_SQL]);
  });

  it("a connection opened before the driver is made strict once, on its first acquire", () => {
    const pool = {
      execute() {},
      on: (e: string, cb: (c: unknown) => void) =>
        (e === "acquire" ? acquireListeners : listeners).push(cb),
    };
    new Mysql2Driver(pool as never);
    const queries: string[] = [];
    const warmed = { query: (sql: string, done: () => void) => (queries.push(sql), done()) };
    for (let i = 0; i < 3; i++) for (const cb of acquireListeners) cb(warmed);
    expect(queries).toEqual([ENSURE_STRICT_SQL]);
    // a connection the pool opens later is handled by `connection`, and not re-queued on acquire
    const fresh = { query: (sql: string, done: () => void) => (queries.push(sql), done()) };
    for (const cb of listeners) cb(fresh);
    for (const cb of acquireListeners) cb(fresh);
    expect(queries).toEqual([ENSURE_STRICT_SQL, ENSURE_STRICT_SQL]);
  });

  it("strictMode: false installs nothing", async () => {
    await new Mysql2Driver("mysql://u@h/db", { strictMode: false }).close();
    expect(listeners).toHaveLength(0);
    await new Mysql2Driver({ host: "h" }, { strictMode: false }).close();
    expect(listeners).toHaveLength(0);
    expect(acquireListeners).toHaveLength(0);
  });
});

describe("Mysql2Driver JSON columns", () => {
  // Since 0.1.155: JSON is read as text, like MariaDB's LONGTEXT JSON and
  // SQLite — the mapper parses it, so a JSON string value stays a string.
  it("reads JSON columns as text (URI and pool-options forms)", async () => {
    await new Mysql2Driver("mysql://u@h/db").close();
    await new Mysql2Driver({ host: "h", jsonStrings: false }).close();
    expect(createPool.mock.calls.map(([opts]) => (opts as any).jsonStrings)).toEqual([true, true]);
  });

  it("the typeCast reads JSON as UTF-8 text whatever the pool's jsonStrings", async () => {
    const { typeCast } = await driverPoolOptions();
    expect(typeCast(jsonField("binary", '"abc"'), () => "parsed")).toBe('"abc"');
    expect(typeCast({ type: "VAR_STRING" }, () => "next")).toBe("next");
  });

  // Since 0.1.177: mysql2 warns "interpreted as BINARY" whenever `string()` is
  // asked for the encoding the column reports, so `string("utf8")` warned once
  // per JSON cell per row on a JSON column reported with a utf8mb4 charset (a
  // view / expression column). The bytes are read instead — never a warning.
  it.each(["binary", "utf8"] as const)(
    "reads a JSON column reported as %s as UTF-8 text without mysql2's BINARY warning",
    async (reported) => {
      const { typeCast } = await driverPoolOptions();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const text = '{"name":"Zoë – 東京"}';
        expect(typeCast(jsonField(reported, text), () => "next")).toBe(text);
        expect(typeCast(jsonField(reported, null), () => "next")).toBeNull();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );
});

// The INSTALLED mysql2's own row parsers — text and binary protocol, and the
// `disableEval` static variants — fed a fabricated JSON column
// definition and row packet: charset 63 (binary) as a server reports a table
// column, 224 (utf8mb4) as it reports some view / expression columns. Catches
// mysql2 changing the typeCast field contract. mysql2's `exports` map blocks
// deep imports, so its files are required by path — if a future mysql2 moves
// them, update the paths here.
const requireCjs = createRequire(import.meta.url);
const mysql2Root = dirname(requireCjs.resolve("mysql2/package.json"));
const mysql2Lib = (file: string): any => requireCjs(join(mysql2Root, "lib", file));

const ROW_TEXT = '{"name": "Zoë – 東京"}';

/** A length-coded value; `null` is the text protocol's NULL marker (0xfb). */
function lengthCoded(bytes: Buffer | null): Buffer {
  if (bytes === null) return Buffer.from([0xfb]);
  if (bytes.length >= 251) throw new Error("keep the test value under 251 bytes");
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

/** One row of one JSON column: a 4-byte header, then the protocol's row body. */
function rowPacket(protocol: "text" | "binary", text: string | null) {
  const value = text === null ? null : Buffer.from(text, "utf8");
  const body =
    protocol === "text"
      ? lengthCoded(value)
      : // status byte, a one-byte NULL bitmap (the first column's bit is 4), then the value
        Buffer.concat([
          Buffer.from([0x00, value === null ? 0x04 : 0x00]),
          value === null ? Buffer.alloc(0) : lengthCoded(value),
        ]);
  const buffer = Buffer.concat([Buffer.alloc(4), body]);
  const Packet = mysql2Lib("packets/packet.js");
  return new Packet(0, buffer, 0, buffer.length);
}

/** A JSON column definition as mysql2 parses it from the server's metadata. */
function jsonColumn(characterSet: number) {
  return {
    name: "payload",
    columnType: mysql2Lib("constants/types.js").JSON,
    characterSet,
    encoding: mysql2Lib("constants/charset_encodings.js")[characterSet],
    columnLength: 0,
    schema: "db",
    table: "v",
    flags: 0,
    decimals: 0,
  };
}

/** The JSON read before 0.1.177 — what mysql2's own warning text recommends. */
function stringUtf8Read(field: any, next: () => unknown): unknown {
  return field.type === "JSON" ? field.string("utf8") : next();
}

type TRow = { next(packet: unknown, fields: unknown[], options: unknown): any };
interface TParserCase {
  name: string;
  protocol: "text" | "binary";
  make: (fields: unknown[], options: unknown, config: unknown) => TRow;
}

const PARSERS: TParserCase[] = [
  {
    name: "text",
    protocol: "text",
    make: (f, o, c) => new (mysql2Lib("parsers/text_parser.js")(f, o, c))(f),
  },
  {
    name: "binary",
    protocol: "binary",
    make: (f, o, c) => new (mysql2Lib("parsers/binary_parser.js")(f, o, c))(),
  },
  {
    name: "static text (disableEval)",
    protocol: "text",
    make: (f, o, c) => mysql2Lib("parsers/static_text_parser.js")(f, o, c),
  },
  {
    name: "static binary (disableEval)",
    protocol: "binary",
    make: (f, o, c) => new (mysql2Lib("parsers/static_binary_parser.js")(f, o, c))(),
  },
];

/** `payload` of a `ROW_TEXT` row and a NULL row, read by the parser with the driver's pool options. */
async function readRows(
  { protocol, make }: TParserCase,
  characterSet: number,
  typeCast?: (field: any, next: () => unknown) => unknown,
): Promise<unknown[]> {
  const config = await driverPoolOptions();
  const options = { typeCast: typeCast ?? config.typeCast };
  const fields = [jsonColumn(characterSet)];
  const parser = make(fields, options, config);
  return [ROW_TEXT, null].map(
    (text) => parser.next(rowPacket(protocol, text), fields, options).payload,
  );
}

describe.each(PARSERS)("Mysql2Driver JSON typeCast in mysql2's $name row parser", (parser) => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it.each([63, 224])(
    "charset %i: the driver's typeCast returns the exact UTF-8 text (and NULL) with no warning",
    async (characterSet) => {
      expect(await readRows(parser, characterSet)).toEqual([ROW_TEXT, null]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("the read before 0.1.177, string('utf8'), warns on the utf8mb4 column: the fixture reproduces the case", async () => {
    expect(await readRows(parser, 63, stringUtf8Read)).toEqual([ROW_TEXT, null]);
    expect(warn).not.toHaveBeenCalled();
    expect(await readRows(parser, 224, stringUtf8Read)).toEqual([ROW_TEXT, null]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("interpreted as BINARY"));
  });
});

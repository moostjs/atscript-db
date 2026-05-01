import { vi, type Mock } from "vite-plus/test";
import { current } from "@wooksjs/event-core";
import { prepareTestHttpContext } from "@wooksjs/event-http";
import { getMoostMate, setControllerContext } from "moost";

import {
  MOOST_DB_ACTION,
  MOOST_DB_ACTION_PARAM,
  MOOST_DB_ACTION_ROW,
  MOOST_DB_ACTION_ROWS,
  type TDbActionMeta,
} from "../actions/keys";
import { boundTableKey } from "../actions/id-cache";
import type { DbActionOpts } from "../actions/types";

/** Per-test logger spy compatible with `TConsoleBase`. */
export type LoggerSpy = {
  info: Mock;
  warn: Mock;
  error: Mock;
  log: Mock;
  debug: Mock;
  trace: Mock;
};

export function makeLogger(): LoggerSpy {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
}

/** Minimal mock app with mutable controller overview. */
export function makeApp(logger: LoggerSpy = makeLogger()): {
  app: any;
  logger: LoggerSpy;
  setOverview(o: unknown[]): void;
} {
  let _overview: unknown[] = [];
  const app: any = {
    getLogger: vi.fn().mockReturnValue(logger),
    getControllersOverview: () => _overview,
  };
  return {
    app,
    logger,
    setOverview(o) {
      _overview = o;
    },
  };
}

/** Bare table mock with ID-typed field descriptors — sufficient for action discovery + ID validation. */
export function makeTable(
  opts: {
    primaryKeys?: string[];
    fieldDescriptors?: Array<{ path: string; designType: string }>;
  } = {},
): any {
  const primaryKeys = opts.primaryKeys ?? ["id"];
  const fieldDescriptors =
    opts.fieldDescriptors ??
    primaryKeys.map((p) => ({
      path: p,
      designType: "string",
      ignored: false,
      isIndexed: true,
      type: { metadata: new Map() },
    }));
  return {
    tableName: "test_table",
    type: {
      __is_atscript_annotated_type: true,
      type: { kind: "object", props: new Map(), propsPatterns: [], tags: new Set() },
      metadata: new Map(),
    },
    flatMap: new Map([["", {}], ...primaryKeys.map((p) => [p, {}] as [string, unknown])]),
    primaryKeys,
    preferredId: [...primaryKeys],
    identifications: [{ fields: [...primaryKeys], source: "primaryKey" }],
    uniqueProps: new Set<string>(),
    indexes: new Map(),
    relations: new Map(),
    fieldDescriptors,
    isView: false,
    isSearchable: vi.fn().mockReturnValue(false),
    isVectorSearchable: vi.fn().mockReturnValue(false),
    getSearchIndexes: vi.fn().mockReturnValue([]),
    getValidator: vi.fn().mockReturnValue({ validate: vi.fn().mockReturnValue(true), errors: [] }),
  };
}

/**
 * Build a synthetic Moost controller-overview entry. The discovery layer
 * reads only `type`, `handlers[].meta`, `handlers[].method`,
 * `handlers[].handler`, and `handlers[].registeredAs[].path` — nothing else
 * matters here.
 */
export interface FakeHandler {
  method: string;
  httpMethod: string;
  path: string;
  action?: { name: string; opts?: DbActionOpts };
  /** The `@Label` decorator value to fall back to when `opts.label` is absent. */
  label?: string;
  paramKinds?: Array<"id" | "ids" | "row" | "rows" | "body" | "other">;
}

export function makeProp(designType: string, annotations: Record<string, unknown> = {}): any {
  return {
    type: { kind: "", designType, tags: new Set() },
    metadata: new Map(Object.entries(annotations)),
  };
}

export function makeValueHelpType(options: {
  interfaceAnnotations?: Record<string, unknown>;
  props: Record<string, { designType: string; annotations?: Record<string, unknown> }>;
}): any {
  const props = new Map<string, any>();
  for (const [name, def] of Object.entries(options.props)) {
    props.set(name, makeProp(def.designType, def.annotations ?? {}));
  }
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "object", props, propsPatterns: [], tags: new Set() },
    metadata: new Map(Object.entries(options.interfaceAnnotations ?? {})),
  };
}

export type ActionParamKind = "id" | "ids" | "row" | "rows";

/** HTTP test-context wrapper for action interceptor / wook tests. */
export function runInActionCtx<T>(
  rawBody: string,
  fn: () => T | Promise<T>,
  opts: { url?: string; method?: string } = {},
): T | Promise<T> {
  return prepareTestHttpContext({
    url: opts.url ?? "/c/act",
    method: opts.method ?? "POST",
    headers: { "content-type": "application/json" },
    rawBody,
  })(fn);
}

/** Invoke a `before` interceptor; converts `reply(v)` → reject. */
export async function runBeforeInterceptor(def: {
  before?: (reply: (v: unknown) => void) => unknown;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    Promise.resolve(def.before!((v: unknown) => reject(v)))
      .then(() => resolve(undefined))
      .catch(reject);
  });
}

/**
 * Write `MOOST_DB_ACTION` + param markers onto a class method via mate.
 * Drives discovery's level inference and the gate / row interceptors.
 */
export function setupActionMeta(
  ctor: Function,
  methodName: string,
  action: { name: string; opts?: Record<string, unknown> },
  paramKinds: ActionParamKind[] = [],
): void {
  const fn = (currentMeta: unknown) =>
    ({
      ...(currentMeta as Record<string, unknown>),
      [MOOST_DB_ACTION]: { name: action.name, opts: action.opts ?? {} },
      params: paramKinds.map((kind) => {
        if (kind === "id") return { [MOOST_DB_ACTION_PARAM]: "id" };
        if (kind === "ids") return { [MOOST_DB_ACTION_PARAM]: "ids" };
        if (kind === "row") return { [MOOST_DB_ACTION_ROW]: true };
        return { [MOOST_DB_ACTION_ROWS]: true };
      }),
    }) as never;
  getMoostMate().decorate(fn as never)(ctor.prototype, methodName);
}

/** Fake table with `findOne` / `findMany` spies — for interceptor + row-cache tests. */
export function makeOpsTable(rows: Record<string, unknown>[]): {
  primaryKeys: string[];
  fieldDescriptors: Array<{ path: string; designType: string }>;
  identifications: readonly { fields: readonly string[]; source: string }[];
  findOne: Mock;
  findMany: Mock;
} {
  return {
    primaryKeys: ["id"],
    fieldDescriptors: [{ path: "id", designType: "string" }],
    identifications: [{ fields: ["id"], source: "primaryKey" }],
    findOne: vi
      .fn()
      .mockImplementation((query: { filter: Record<string, unknown> }) =>
        Promise.resolve(rows.find((r) => matchesFilter(r, query.filter)) ?? null),
      ),
    findMany: vi.fn().mockResolvedValue(rows),
  };
}

/** ID-validation-only fake table — for cached-ID-wook tests. */
export function makePkOnlyTable(designType: "string" | "number" = "string"): {
  primaryKeys: string[];
  fieldDescriptors: Array<{ path: string; designType: string }>;
  identifications: readonly { fields: readonly string[]; source: string }[];
} {
  return {
    primaryKeys: ["id"],
    fieldDescriptors: [{ path: "id", designType }],
    identifications: [{ fields: ["id"], source: "primaryKey" }],
  };
}

function matchesFilter(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => Object.is(row[key], value));
}

/** Wrap `setControllerContext` for the in-test controller. */
export function bindController(ctrl: object, methodName: string, url = "/c/act"): void {
  setControllerContext(ctrl as never, methodName, url);
}

/**
 * Bind a duck-type controller (`{ readable: table }`) for tests that exercise
 * the `useControllerContext().getController()` fallback path. The prototype
 * trick is needed so `getController().constructor` is a real class.
 */
export function bindDuckTypeController(
  table: unknown,
  methodName = "handler",
  url = "/c/act",
): void {
  const ctrl = { readable: table };
  class FakeCtrl {
    handler() {}
  }
  Object.setPrototypeOf(ctrl, FakeCtrl.prototype);
  setControllerContext(ctrl as never, methodName, url);
}

/** Seed the bound-table slot on the current event context. */
export function setBoundTable(table: unknown): void {
  current().set(boundTableKey, table);
}

export function fakeOverview(ctor: Function, handlers: FakeHandler[]): unknown {
  const sharedMethodMeta = new Map<string, Record<string, unknown>>();
  // Group all verbs sharing the same JS method-name under one methodMeta —
  // matches Moost's bindController behaviour where `methodMeta.handlers` is
  // a single array.
  for (const h of handlers) {
    if (sharedMethodMeta.has(h.method)) continue;
    const params = (h.paramKinds ?? []).map((kind) => {
      if (kind === "body") return { paramSource: "BODY" };
      if (kind === "id") return { [MOOST_DB_ACTION_PARAM]: "id" };
      if (kind === "ids") return { [MOOST_DB_ACTION_PARAM]: "ids" };
      if (kind === "row") return { [MOOST_DB_ACTION_ROW]: true };
      if (kind === "rows") return { [MOOST_DB_ACTION_ROWS]: true };
      return {};
    });
    const action: TDbActionMeta | undefined = h.action
      ? { name: h.action.name, opts: h.action.opts ?? {} }
      : undefined;
    const methodMeta: Record<string, unknown> = {
      params,
      handlers: handlers
        .filter((x) => x.method === h.method)
        .map((x) => ({ method: x.httpMethod, path: x.path, type: "HTTP" })),
    };
    if (action) methodMeta[MOOST_DB_ACTION] = action;
    if (h.label) methodMeta.label = h.label;
    sharedMethodMeta.set(h.method, methodMeta);
  }
  const handlerEntries = handlers.map((h) => ({
    meta: sharedMethodMeta.get(h.method),
    method: h.method,
    type: "HTTP",
    handler: { method: h.httpMethod, path: h.path, type: "HTTP" },
    registeredAs: [{ path: h.path, args: [] }],
  }));
  return {
    type: ctor,
    computedPrefix: "",
    meta: {},
    handlers: handlerEntries,
  };
}

import { vi, type Mock } from "vite-plus/test";

import { MOOST_DB_ACTION, MOOST_DB_ACTION_PARAM, type TDbActionMeta } from "../actions/keys";
import type { DbActionOpts } from "../actions/types";

/** Per-test logger spy compatible with `TConsoleBase`. */
export type LoggerSpy = {
  info: Mock;
  warn: Mock;
  error: Mock;
  log: Mock;
  debug: Mock;
};

export function makeLogger(): LoggerSpy {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
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

/** Bare table mock with PK-typed field descriptors — sufficient for action discovery + PK validation. */
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
  paramKinds?: Array<"pk" | "pks" | "body" | "other">;
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

export function fakeOverview(ctor: Function, handlers: FakeHandler[]): unknown {
  const sharedMethodMeta = new Map<string, Record<string, unknown>>();
  // Group all verbs sharing the same JS method-name under one methodMeta —
  // matches Moost's bindController behaviour where `methodMeta.handlers` is
  // a single array.
  for (const h of handlers) {
    if (sharedMethodMeta.has(h.method)) continue;
    const params = (h.paramKinds ?? []).map((kind) => {
      if (kind === "body") return { paramSource: "BODY" };
      if (kind === "pk") return { [MOOST_DB_ACTION_PARAM]: "pk" };
      if (kind === "pks") return { [MOOST_DB_ACTION_PARAM]: "pks" };
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

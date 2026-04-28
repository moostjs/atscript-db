import type { TDbActionInfo, TDbActionLevel } from "@atscript/db";
import type { Moost, TConsoleBase } from "moost";
import { getMoostMate } from "moost";

import {
  MOOST_DB_ACTION,
  MOOST_DB_ACTION_PARAM,
  MOOST_DB_ACTIONS,
  type TDbActionMeta,
  type TDbClassActionMeta,
  type TDbActionParamKind,
} from "./keys";
import type { DbActionOpts, TDbActionsEntry } from "./types";

/** Optional fields shared between method opts and class-level entries. */
const OPTIONAL_FIELDS = [
  "icon",
  "intent",
  "description",
  "order",
  "default",
  "promptText",
] as const;
type OptionalField = (typeof OPTIONAL_FIELDS)[number];

const WARN_PREFIX = "[moost-db actions]";

const actionsCache = new WeakMap<Function, TDbActionInfo[]>();

/**
 * Discover all actions declared on a controller and produce the `/meta` array.
 * Reads class + method metadata via `getMoostMate()` and resolves bound POST
 * paths through the Moost controller overview.
 *
 * Result is memoized per controller constructor — discovery walks every
 * handler entry and reads decorator metadata, which is wasted work to repeat
 * across instances.
 */
export function discoverActions(
  controllerCtor: Function,
  app: Moost,
  logger: TConsoleBase,
): TDbActionInfo[] {
  const cached = actionsCache.get(controllerCtor);
  if (cached) return cached;
  const overview = app
    .getControllersOverview?.()
    ?.find((o) => o.type === controllerCtor) as unknown as MoostControllerOverview | undefined;
  const out: TDbActionInfo[] = [];
  collectMethodActions(controllerCtor, overview, logger, out);
  collectClassActions(controllerCtor, logger, out);
  applyDefaultPerLevel(out, logger);
  actionsCache.set(controllerCtor, out);
  return out;
}

// ── Method-decorator actions ──────────────────────────────────────────────

interface MoostHandlerEntry {
  meta: { handlers?: { method: string; path?: string; type?: string }[] } & Record<string, unknown>;
  method: string;
  type: string;
  handler: { method: string; path?: string; type?: string };
  registeredAs: { path: string; args: string[] }[];
}

interface MoostControllerOverview {
  type: Function;
  computedPrefix: string;
  meta: Record<string, unknown>;
  handlers: MoostHandlerEntry[];
}

function collectMethodActions(
  ctor: Function,
  overview: MoostControllerOverview | undefined,
  logger: TConsoleBase,
  out: TDbActionInfo[],
): void {
  if (!overview) return;
  const byMethod = new Map<string, MoostHandlerEntry[]>();
  for (const h of overview.handlers) {
    const list = byMethod.get(h.method);
    if (list) list.push(h);
    else byMethod.set(h.method, [h]);
  }
  for (const [methodName, handlers] of byMethod) {
    const methodMeta = handlers[0].meta;
    const action = methodMeta[MOOST_DB_ACTION] as TDbActionMeta | undefined;
    if (!action) continue;
    if (!action.name) {
      logger.warn(
        `${WARN_PREFIX} method "${methodName}" has @DbActionDefault() but no @DbAction(name) — dropping`,
      );
      continue;
    }

    const params = (methodMeta as { params?: Record<string, unknown>[] }).params ?? [];
    const levelInfer = inferMethodLevel(params, action.name, logger);
    if (!levelInfer) continue;
    if (levelInfer.bodyConflict) {
      logger.warn(
        `${WARN_PREFIX} action "${action.name}" cannot mix @DbActionPK*/@DbActionPKs with @Body() — dropping`,
      );
      continue;
    }

    const postEntry = handlers.find(
      (h) => h.handler.type === "HTTP" && h.handler.method === "POST",
    );
    if (!postEntry) {
      logger.warn(
        `${WARN_PREFIX} action "${action.name}" requires @Post(...); no POST handler bound to ${methodName} — dropping`,
      );
      continue;
    }
    const path = postEntry.registeredAs[0]?.path;
    if (!path) {
      logger.warn(
        `${WARN_PREFIX} action "${action.name}" — POST handler ${methodName} has no registered path — dropping`,
      );
      continue;
    }

    const label = action.opts.label ?? (methodMeta as { label?: string }).label;
    if (!label) {
      logger.warn(
        `${WARN_PREFIX} action "${action.name}" requires a label (opts.label or @Label) — dropping`,
      );
      continue;
    }

    const info: TDbActionInfo = {
      name: action.name,
      label,
      level: levelInfer.level,
      processor: "backend",
      value: path,
    };
    copyOptionalFields(info, action.opts);
    out.push(info);
  }
}

interface LevelInferResult {
  level: TDbActionLevel;
  bodyConflict: boolean;
}

function inferMethodLevel(
  params: Record<string, unknown>[],
  actionName: string,
  logger: TConsoleBase,
): LevelInferResult | null {
  let hasPk = false;
  let hasPks = false;
  let hasBody = false;
  for (const p of params) {
    const kind = p[MOOST_DB_ACTION_PARAM] as TDbActionParamKind | undefined;
    if (kind === "pk") hasPk = true;
    else if (kind === "pks") hasPks = true;
    if (p.paramSource === "BODY") hasBody = true;
  }
  if (hasPk && hasPks) {
    logger.warn(
      `${WARN_PREFIX} action "${actionName}" has both @DbActionPK and @DbActionPKs — dropping`,
    );
    return null;
  }
  const level: TDbActionLevel = hasPk ? "row" : hasPks ? "rows" : "table";
  return { level, bodyConflict: hasBody && level !== "table" };
}

// ── Class-level actions ───────────────────────────────────────────────────

function collectClassActions(ctor: Function, logger: TConsoleBase, out: TDbActionInfo[]): void {
  const classMeta = getMoostMate().read(ctor) as
    | { [MOOST_DB_ACTIONS]?: TDbClassActionMeta[] }
    | undefined;
  const list = classMeta?.[MOOST_DB_ACTIONS];
  if (!list) return;
  for (const { name, entry, forcedLevel } of list) {
    const built = buildClassEntry(name, entry, forcedLevel, logger);
    if (built) out.push(built);
  }
}

function buildClassEntry(
  name: string,
  entry: TDbActionsEntry,
  forcedLevel: TDbActionLevel | undefined,
  logger: TConsoleBase,
): TDbActionInfo | null {
  const level = forcedLevel ?? entry.level;
  if (!level) {
    logger.warn(
      `${WARN_PREFIX} class-level action "${name}" requires a level — dropping. Use @DbTableActions/@DbRowActions/@DbRowsActions or set "level" explicitly.`,
    );
    return null;
  }
  if (!entry.label) {
    logger.warn(`${WARN_PREFIX} class-level action "${name}" requires a label — dropping`);
    return null;
  }
  const processor = entry.processor;
  let value: string;
  if (processor === "navigate" || processor === "backend") {
    const v = (entry as { value?: unknown }).value;
    if (typeof v !== "string" || v === "") {
      logger.warn(
        `${WARN_PREFIX} class-level action "${name}" with processor "${processor}" requires a non-empty "value" — dropping`,
      );
      return null;
    }
    value = v;
  } else if (processor === "custom") {
    const v = (entry as { value?: unknown }).value;
    if (v !== undefined && v !== null) {
      logger.warn(
        `${WARN_PREFIX} class-level action "${name}" with processor "custom" forbids "value" (always derived from the dict key) — dropping`,
      );
      return null;
    }
    value = name;
  } else {
    logger.warn(
      `${WARN_PREFIX} class-level action "${name}" has unknown processor "${String(processor)}" — dropping`,
    );
    return null;
  }
  const info: TDbActionInfo = {
    name,
    label: entry.label,
    level,
    processor,
    value,
  };
  copyOptionalFields(info, entry);
  return info;
}

// ── Default-per-level resolution ──────────────────────────────────────────

function applyDefaultPerLevel(actions: TDbActionInfo[], logger: TConsoleBase): void {
  const winners = new Map<TDbActionLevel, string>();
  for (const a of actions) {
    if (!a.default) continue;
    const existing = winners.get(a.level);
    if (existing) {
      a.default = false;
      logger.warn(
        `${WARN_PREFIX} duplicate default action at level "${a.level}": "${existing}" wins, "${a.name}" demoted`,
      );
    } else {
      winners.set(a.level, a.name);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function copyOptionalFields(info: TDbActionInfo, source: DbActionOpts | TDbActionsEntry): void {
  for (const key of OPTIONAL_FIELDS) {
    const value = (source as Record<OptionalField, unknown>)[key];
    if (value !== undefined) {
      (info as Record<OptionalField, unknown>)[key] = value;
    }
  }
}

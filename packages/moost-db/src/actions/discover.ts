import type { TDbActionInfo, TDbActionLevel } from "@atscript/db";
import type { Moost, TConsoleBase } from "moost";
import { getMoostMate } from "moost";

import { isAsDbReadableControllerSubclass } from "./controller-registry";
import {
  MOOST_DB_ACTION,
  MOOST_DB_ACTIONS,
  WARN_PREFIX,
  type TDbActionMeta,
  type TDbClassActionMeta,
} from "./keys";
import { scanParamLevel } from "./param-level";
import type { DbActionOpts, TDbActionsEntry } from "./types";

/**
 * Pure structural-copy fields. `disabled` and `requiredFields` are handled
 * as special cases in {@link emitInfo} so the function-to-string transform
 * stays out of the copy loop.
 */
const OPTIONAL_FIELDS = [
  "icon",
  "intent",
  "description",
  "order",
  "default",
  "promptText",
  "shortcut",
] as const;
type OptionalField = (typeof OPTIONAL_FIELDS)[number];

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
        `${WARN_PREFIX} action "${action.name}" cannot mix @DbActionID*/@DbActionIDs/@DbActionRow*/@DbActionRows with @Body() — dropping`,
      );
      continue;
    }

    // ── 'table' + disabled rejection ──
    if (levelInfer.level === "table" && action.opts.disabled !== undefined) {
      logger.warn(
        `${WARN_PREFIX} action "${action.name}" — \`disabled\` is not allowed at the 'table' level; ` +
          `row-state predicates are not meaningful when no row is in scope. Use @Authenticate / arbac for ` +
          `table-level access — dropping`,
      );
      continue;
    }

    const isGated = action.opts.disabled !== undefined || levelInfer.hasRowParam;
    if (isGated) {
      const extendsReadable = isAsDbReadableControllerSubclass(ctor);
      const hasOptsTable = action.opts.table != null;
      if (!extendsReadable && !hasOptsTable) {
        logger.warn(
          `${WARN_PREFIX} action "${action.name}" declares a gate or row injection but the controller does ` +
            `not extend AsDbReadableController and \`opts.table\` is not provided. Either extend ` +
            `AsDbReadableController / AsDbController or pass \`opts.table\` on @DbAction — dropping`,
        );
        continue;
      }
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
    emitInfo(info, action.opts, action.name, logger);
    out.push(info);
  }
}

interface LevelInferResult {
  level: TDbActionLevel;
  bodyConflict: boolean;
  hasRowParam: boolean;
}

function inferMethodLevel(
  params: Record<string, unknown>[],
  actionName: string,
  logger: TConsoleBase,
): LevelInferResult | null {
  const scan = scanParamLevel(params);
  if (scan.single && scan.multi) {
    logger.warn(
      `${WARN_PREFIX} action "${actionName}" mixes single-cardinality and multi-cardinality decorators ` +
        `(@DbActionID / @DbActionRow vs @DbActionIDs / @DbActionRows) — dropping`,
    );
    return null;
  }
  return {
    level: scan.level as TDbActionLevel,
    bodyConflict: scan.hasBody && scan.level !== "table",
    hasRowParam: scan.hasRowParam,
  };
}

// ── Class-level actions ───────────────────────────────────────────────────

function collectClassActions(ctor: Function, logger: TConsoleBase, out: TDbActionInfo[]): void {
  const classMeta = getMoostMate().read(ctor) as
    | { [MOOST_DB_ACTIONS]?: TDbClassActionMeta[] }
    | undefined;
  const list = classMeta?.[MOOST_DB_ACTIONS];
  if (!list) return;
  for (const { name, entry } of list) {
    const built = buildClassEntry(name, entry, logger);
    if (built) out.push(built);
  }
}

function buildClassEntry(
  name: string,
  entry: TDbActionsEntry,
  logger: TConsoleBase,
): TDbActionInfo | null {
  const level = entry.level;
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
  // ── 'table' + disabled rejection (class-level) ──
  if (level === "table" && entry.disabled !== undefined) {
    logger.warn(
      `${WARN_PREFIX} class-level action "${name}" — \`disabled\` is not allowed at the 'table' level — dropping`,
    );
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
  // Class-level dict entries forward `disabled.toString()` and `requiredFields`
  // EXACTLY as for method-decorator actions. The server does NOT register a
  // gate interceptor here — class-level entries point at endpoints (possibly
  // in other controllers) where the decorator can't introspect a method;
  // server enforcement is the dev's responsibility (typically by adding
  // `@DbAction(name, { disabled })` on the actual handler).
  emitInfo(info, entry, name, logger);
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

/**
 * Emit structural-copy fields plus `disabled` (stringified) and
 * `requiredFields` (forwarded verbatim — server doesn't auto-derive).
 * `requiredFields` without `disabled` is dropped with a warning before the
 * structural copy runs, so method-decorator and class-level-dict origins
 * stay symmetric.
 */
function emitInfo(
  info: TDbActionInfo,
  source: DbActionOpts | TDbActionsEntry,
  name: string,
  logger: TConsoleBase,
): void {
  const disabled = (source as { disabled?: unknown }).disabled;
  const hasDisabled = typeof disabled === "function";
  let requiredFields = (source as { requiredFields?: unknown }).requiredFields;
  if (!hasDisabled && requiredFields !== undefined) {
    logger.warn(
      `${WARN_PREFIX} action "${name}" has \`requiredFields\` without \`disabled\` — \`requiredFields\` is ` +
        `purely a UI hint and meaningless without a predicate. Dropping \`requiredFields\` from /meta.`,
    );
    requiredFields = undefined;
  }
  copyOptionalFields(info, source);
  // The result is memoized in `actionsCache`; defensively clone the tuple
  // form of `promptText` so a downstream mutation of the dev-supplied opts
  // can't shift the cached wire output.
  if (Array.isArray(info.promptText)) {
    info.promptText = info.promptText.slice() as [string, string];
  }
  if (hasDisabled) {
    info.disabled = (disabled as () => unknown).toString();
  }
  if (Array.isArray(requiredFields)) {
    info.requiredFields = requiredFields.slice();
  }
}

function copyOptionalFields(info: TDbActionInfo, source: DbActionOpts | TDbActionsEntry): void {
  for (const key of OPTIONAL_FIELDS) {
    const value = (source as Record<OptionalField, unknown>)[key];
    if (value !== undefined) {
      (info as Record<OptionalField, unknown>)[key] = value;
    }
  }
}

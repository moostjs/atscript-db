import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";
import type { TDbActionInfo, TDbActionLevel } from "@atscript/db";
import type { Moost, TConsoleBase } from "moost";

import { getAtscriptDbMate } from "../mate";
import { isAsDbReadableControllerSubclass } from "./controller-registry";
import { WARN_PREFIX, type TDbActionInputFormMeta, type TDbActionMeta } from "./keys";
import { scanParamLevel } from "./param-level";
import type { DbActionOpts, TDbActionsEntry } from "./types";

/** Structural-copy fields; `disabled` is handled separately in {@link emitInfo} (function-to-string transform). */
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

/**
 * Pairs the wire-shaped `info` with the original decorator opts / dict entry,
 * so the augmenter can invoke the live `disabled` reference (deliberately
 * absent from the wire `info`).
 */
export interface TDbActionEnvelope {
  info: TDbActionInfo;
  raw: DbActionOpts | TDbActionsEntry;
}

const actionsCache = new WeakMap<Function, TDbActionEnvelope[]>();
const rowLevelActionsCache = new WeakMap<Function, TDbActionEnvelope[]>();

/**
 * Per-controller registry of form names → compiled `.as` classes, populated
 * during {@link discoverActions} when a method param carries
 * `atscript_db_action_input_form`. Backs `GET /meta/form/:name`.
 *
 * Same name + same type ref across multiple actions is fine (forms can be
 * reused). Same name + *different* type refs is an ambiguity — discovery
 * warns and drops the second action.
 */
const formRegistry = new WeakMap<Function, Map<string, TAtscriptAnnotatedType>>();

/** Lookup helper for `AsReadableController.metaForm()`. */
export function getControllerFormType(
  ctor: Function,
  name: string,
): TAtscriptAnnotatedType | undefined {
  return formRegistry.get(ctor)?.get(name);
}

function registerFormType(
  ctor: Function,
  meta: TDbActionInputFormMeta,
  actionName: string,
  logger: TConsoleBase,
): boolean {
  let map = formRegistry.get(ctor);
  if (!map) {
    map = new Map();
    formRegistry.set(ctor, map);
  }
  const existing = map.get(meta.name);
  if (existing && existing !== meta.type) {
    logger.warn(
      `${WARN_PREFIX} action "${actionName}" — form name "${meta.name}" already registered on this controller with a different type. ` +
        `Reusing the same FormType across actions is fine; clashing names are not — dropping`,
    );
    return false;
  }
  if (!existing) map.set(meta.name, meta.type);
  return true;
}

/** Discover actions on a controller, memoized per ctor. `info`-only callers map `e => e.info`. */
export function discoverActions(
  controllerCtor: Function,
  app: Moost,
  logger: TConsoleBase,
): TDbActionEnvelope[] {
  const cached = actionsCache.get(controllerCtor);
  if (cached) return cached;
  const overview = app
    .getControllersOverview?.()
    ?.find((o) => o.type === controllerCtor) as unknown as MoostControllerOverview | undefined;
  const out: TDbActionEnvelope[] = [];
  const seen = new Set<string>();
  collectMethodActions(controllerCtor, overview, logger, out, seen);
  collectClassActions(controllerCtor, logger, out, seen);
  applyDefaultPerLevel(out, logger);
  actionsCache.set(controllerCtor, out);
  return out;
}

/** Row/rows-level subset of {@link discoverActions}; memoized per ctor. */
export function discoverRowLevelActions(
  controllerCtor: Function,
  app: Moost,
  logger: TConsoleBase,
): TDbActionEnvelope[] {
  const cached = rowLevelActionsCache.get(controllerCtor);
  if (cached) return cached;
  const filtered = discoverActions(controllerCtor, app, logger).filter(
    (e) => e.info.level === "row" || e.info.level === "rows",
  );
  rowLevelActionsCache.set(controllerCtor, filtered);
  return filtered;
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
  out: TDbActionEnvelope[],
  seen: Set<string>,
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
    const action = methodMeta.atscript_db_action as TDbActionMeta | undefined;
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

    // ── disabled requires requiredFields ──
    if (action.opts.disabled !== undefined && !isNonEmptyStringArray(action.opts.requiredFields)) {
      logger.warn(
        `${WARN_PREFIX} action "${action.name}" — \`disabled\` requires a non-empty \`requiredFields\` ` +
          `array (the predicate's field dependencies must be declared explicitly) — dropping`,
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

    if (seen.has(action.name)) {
      logger.warn(
        `${WARN_PREFIX} duplicate action name "${action.name}" within controller — dropping the second declaration`,
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
    if (levelInfer.inputForm) {
      if (!registerFormType(ctor, levelInfer.inputForm, action.name, logger)) continue;
      info.inputForm = levelInfer.inputForm.name;
    }
    emitInfo(info, action.opts);
    seen.add(action.name);
    out.push({ info, raw: action.opts });
  }
}

interface LevelInferResult {
  level: TDbActionLevel;
  bodyConflict: boolean;
  hasRowParam: boolean;
  inputForm?: TDbActionInputFormMeta;
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
  if (scan.hasDuplicateInputForm) {
    logger.warn(
      `${WARN_PREFIX} action "${actionName}" has more than one @InputForm() param — only the first is honored. ` +
        `Compose multiple inputs into a single form interface.`,
    );
  }
  return {
    level: scan.level as TDbActionLevel,
    bodyConflict: scan.hasBody && scan.level !== "table",
    hasRowParam: scan.hasRowParam,
    inputForm: scan.inputForm,
  };
}

// ── Class-level actions ───────────────────────────────────────────────────

function collectClassActions(
  ctor: Function,
  logger: TConsoleBase,
  out: TDbActionEnvelope[],
  seen: Set<string>,
): void {
  const classMeta = getAtscriptDbMate().read(ctor);
  const list = classMeta?.atscript_db_actions;
  if (!list) return;
  for (const { name, entry } of list) {
    if (seen.has(name)) {
      logger.warn(
        `${WARN_PREFIX} duplicate action name "${name}" within controller — dropping the second declaration`,
      );
      continue;
    }
    const built = buildClassEntry(name, entry, logger);
    if (built) {
      seen.add(name);
      out.push({ info: built, raw: entry });
    }
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
  // ── disabled requires requiredFields (class-level) ──
  if (entry.disabled !== undefined && !isNonEmptyStringArray(entry.requiredFields)) {
    logger.warn(
      `${WARN_PREFIX} class-level action "${name}" — \`disabled\` requires a non-empty ` +
        `\`requiredFields\` array (the predicate's field dependencies must be declared explicitly) — dropping`,
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
  // Class-level dict entries forward `disabled.toString()` EXACTLY as for
  // method-decorator actions. The server does NOT register a gate interceptor
  // here — class-level entries point at endpoints (possibly in other
  // controllers) where the decorator can't introspect a method; server
  // enforcement is the dev's responsibility (typically by adding
  // `@DbAction(name, { disabled })` on the actual handler).
  emitInfo(info, entry);
  return info;
}

// ── Default-per-level resolution ──────────────────────────────────────────

function applyDefaultPerLevel(envelopes: TDbActionEnvelope[], logger: TConsoleBase): void {
  const winners = new Map<TDbActionLevel, string>();
  for (const { info } of envelopes) {
    if (!info.default) continue;
    const existing = winners.get(info.level);
    if (existing) {
      info.default = false;
      logger.warn(
        `${WARN_PREFIX} duplicate default action at level "${info.level}": "${existing}" wins, "${info.name}" demoted`,
      );
    } else {
      winners.set(info.level, info.name);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Emit structural-copy fields plus stringified `disabled`. `requiredFields` is server-internal (never on the wire). */
function emitInfo(info: TDbActionInfo, source: DbActionOpts | TDbActionsEntry): void {
  const disabled = (source as { disabled?: unknown }).disabled;
  const hasDisabled = typeof disabled === "function";
  copyOptionalFields(info, source);
  // WHY: the result is memoized in `actionsCache`, so clone the tuple form of `promptText` to prevent dev-supplied mutations from shifting cached output.
  if (Array.isArray(info.promptText)) {
    info.promptText = info.promptText.slice() as [string, string];
  }
  if (hasDisabled) {
    info.disabled = (disabled as () => unknown).toString();
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

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

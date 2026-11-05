/**
 * The request's translation of a served `/meta` envelope or form schema (since
 * 0.1.170) — the last layer, after every per-principal overlay. Texts are
 * translated with moost's translator (`setTranslator`), the type root gets the
 * texts a client translates itself as `$i18n`.
 */

import { DB_VALIDATOR_MESSAGES, isEmptyObject } from "@atscript/db";
import type { TDbActionInfo, TMetaResponse } from "@atscript/db";
import {
  translateServed,
  VALIDATOR_MESSAGES,
  type TSerializedAnnotatedType,
} from "@atscript/typescript/utils";
import { registerMessages, type TTranslation } from "moost";

import { isStableMeta, markStableMeta } from "./meta-cache";

// The validator's templates and the db plugin's: what a translation's
// `messages()` serves as `$i18n`, and the English fallback of their codes.
registerMessages(VALIDATOR_MESSAGES);
registerMessages(DB_VALIDATOR_MESSAGES);

/**
 * Memoized outputs per input object, then per locale — each with the
 * translation key it was made under. A key changes with every
 * `setTranslator` / `registerMessages` generation: the locale's entry is
 * then replaced, so an input keeps one output per served locale and no
 * outdated generation.
 */
type TMemo<T> = WeakMap<object, Map<string, { key: string; out: T }>>;

/** `translateServed` results per serialized type (its own memo, outside the `/meta` variant budget). */
const servedMemo: TMemo<{ value: unknown; texts: Record<string, string> }> = new WeakMap();
/** Localized envelopes / form schemas per input. */
const outputMemo: TMemo<object> = new WeakMap();

/** `compute()` once per (input, locale, key); per call when the key is undefined. */
function memo<T>(store: TMemo<T>, input: object, translation: TTranslation, compute: () => T): T {
  const key = translation.key;
  if (key === undefined) return compute();
  let byLocale = store.get(input);
  const hit = byLocale?.get(translation.locale);
  if (hit?.key === key) return hit.out;
  const out = compute();
  if (!byLocale) store.set(input, (byLocale = new Map()));
  byLocale.set(translation.locale, { key, out });
  return out;
}

/**
 * The text's translation, `undefined` when it has none: the source text is
 * the id (`$1` / `$N` placeholders and `{name}` stay as the translator wrote
 * them — no params are filled).
 */
function textTranslator(translation: TTranslation): (text: string) => string | undefined {
  return (text) => {
    const out = translation.t(text, undefined, text);
    return out === text ? undefined : out;
  };
}

/** {@link translateServed} of `json`, memoized per (object, key). */
function served<T extends object>(
  json: T,
  translation: TTranslation,
): { value: T; texts: Record<string, string> } {
  return memo(servedMemo, json, translation, () =>
    translateServed(json, textTranslator(translation)),
  ) as { value: T; texts: Record<string, string> };
}

/**
 * `output` for `input` under `translation`, memoized per (input, key) when
 * `input` is identity-stable and the key defined — the output is then stable
 * too (served with an `ETag`). Otherwise computed per request.
 */
function localized<T extends object>(input: T, translation: TTranslation, build: () => T): T {
  if (translation.key === undefined || !isStableMeta(input)) return build();
  return memo(outputMemo, input, translation, () => {
    const out = build();
    return out === input ? out : markStableMeta(out);
  }) as T;
}

/** The `$i18n` of a served type: translated templates, then the expressions' texts. */
function i18nOf(
  translation: TTranslation,
  texts: Record<string, string>,
): Readonly<Record<string, string>> | undefined {
  const messages = translation.messages(); // frozen, memoized per key by moost
  const i18n = isEmptyObject(texts) ? messages : { ...messages, ...texts };
  return isEmptyObject(i18n) ? undefined : i18n;
}

/** `type` with `$i18n` (the type itself without one). */
function withI18n(
  type: TSerializedAnnotatedType,
  i18n: Readonly<Record<string, string>> | undefined,
): TSerializedAnnotatedType {
  return i18n ? { ...type, $i18n: i18n } : type;
}

/**
 * `/meta` in the request's language: `type` and `decorations` translated,
 * the actions' `label` / `description` / `promptText` translated, and
 * `type.$i18n` holding the translated registered templates and the expression
 * texts. The envelope itself when nothing changes.
 */
export function localizeMeta(meta: TMetaResponse, translation: TTranslation): TMetaResponse {
  return localized(meta, translation, () => {
    const type = served(meta.type, translation);
    const decorations = meta.decorations && served(meta.decorations, translation);
    const actions = translateActions(meta.actions, textTranslator(translation));
    const i18n = i18nOf(
      translation,
      decorations ? { ...type.texts, ...decorations.texts } : type.texts,
    );
    if (
      !i18n &&
      type.value === meta.type &&
      decorations?.value === meta.decorations &&
      actions === meta.actions
    ) {
      return meta;
    }
    const out: TMetaResponse = { ...meta, type: withI18n(type.value, i18n), actions };
    if (decorations) out.decorations = decorations.value;
    return out;
  });
}

/** A `/meta/form/:name` schema in the request's language (see {@link localizeMeta}). */
export function localizeForm(
  schema: TSerializedAnnotatedType,
  translation: TTranslation,
): TSerializedAnnotatedType {
  return localized(schema, translation, () => {
    const { value, texts } = served(schema, translation);
    return withI18n(value, i18nOf(translation, texts));
  });
}

/** Actions with translated `label` / `description` / `promptText` (the list itself when none changes). */
function translateActions(
  actions: TDbActionInfo[],
  t: (text: string) => string | undefined,
): TDbActionInfo[] {
  let out: TDbActionInfo[] | undefined;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const label = t(action.label);
    const description = action.description === undefined ? undefined : t(action.description);
    const promptText = translatePrompt(action.promptText, t);
    if (label === undefined && description === undefined && promptText === undefined) continue;
    out ??= actions.slice();
    out[i] = {
      ...action,
      ...(label === undefined ? {} : { label }),
      ...(description === undefined ? {} : { description }),
      ...(promptText === undefined ? {} : { promptText }),
    };
  }
  return out ?? actions;
}

/** A translated prompt (`undefined` when nothing changes). */
function translatePrompt(
  prompt: TDbActionInfo["promptText"],
  t: (text: string) => string | undefined,
): TDbActionInfo["promptText"] | undefined {
  if (typeof prompt === "string") return t(prompt);
  if (!Array.isArray(prompt)) return undefined;
  const one = t(prompt[0]);
  const many = t(prompt[1]);
  return one === undefined && many === undefined
    ? undefined
    : [one ?? prompt[0], many ?? prompt[1]];
}

import { describe, it, expect } from "vite-plus/test";
import type { TMetaResponse } from "@atscript/db";
import type { TTranslation } from "moost";

import { markStableMeta } from "../meta/meta-cache";
import { localizeMeta } from "../meta/meta-i18n";

/**
 * The translation memo of `/meta`: per-principal variants share the
 * translated `type` (one translation per serialized type and locale), keep
 * their own actions, and a new translator generation replaces a locale's
 * entry instead of piling up next to it.
 */

const DE: Record<string, string> = { Title: "Titel", Archive: "Archivieren", Close: "Schließen" };

function translation(key: string, locale = "de"): TTranslation {
  return {
    locale,
    key,
    t: (id, _params, fallback) => DE[id] ?? fallback ?? id,
    messages: () => ({ REQUIRED: "Darf nicht leer sein" }),
  };
}

const type = {
  $v: 1,
  type: {
    kind: "object",
    props: {
      title: { type: { kind: "", designType: "string" }, metadata: { "meta.label": "Title" } },
    },
  },
  metadata: {},
} as unknown as TMetaResponse["type"];

function variant(actions: string[]): TMetaResponse {
  return markStableMeta({
    type,
    actions: actions.map((name) => ({
      name,
      label: name[0]!.toUpperCase() + name.slice(1),
      level: "table",
      processor: "custom",
      value: name,
    })),
  } as unknown as TMetaResponse);
}

const labelOf = (meta: TMetaResponse) =>
  (meta.type.type as any).props.title.metadata["meta.label"] as string;

describe("meta translation memo", () => {
  it("variants of one envelope share the translated type and keep their own actions", () => {
    const roleA = variant(["archive", "close"]);
    const roleB = variant(["close"]);
    const a = localizeMeta(roleA, translation("1:de"));
    const b = localizeMeta(roleB, translation("1:de"));
    // one translation of the shared serialized type (the root only adds `$i18n`)
    expect(a.type.type).toBe(b.type.type);
    expect(labelOf(a)).toBe("Titel");
    expect(a.type.$i18n).toEqual({ REQUIRED: "Darf nicht leer sein" });
    expect(a.actions.map((x) => x.label)).toEqual(["Archivieren", "Schließen"]);
    expect(b.actions.map((x) => x.label)).toEqual(["Schließen"]);
    // memoized per variant × key: the same objects again (stable → served with an ETag)
    expect(localizeMeta(roleA, translation("1:de"))).toBe(a);
    expect(localizeMeta(roleB, translation("1:de"))).toBe(b);
  });

  it("locales are kept side by side", () => {
    const meta = variant(["archive"]);
    const de = localizeMeta(meta, translation("1:de"));
    const en = localizeMeta(meta, { ...translation("1:en", "en"), t: (_id, _p, fb) => fb! });
    expect(localizeMeta(meta, translation("1:de"))).toBe(de);
    expect(en).not.toBe(de);
  });

  it("a new generation replaces the locale's entry (the old one is not kept)", () => {
    const meta = variant(["archive"]);
    const first = localizeMeta(meta, translation("1:de"));
    const second = localizeMeta(meta, translation("2:de"));
    expect(second).not.toBe(first);
    // back to the first key: recomputed — its entry was dropped, not retained
    const again = localizeMeta(meta, translation("1:de"));
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });
});

import {
  MOOST_DB_ACTION_PARAM,
  MOOST_DB_ACTION_ROW,
  MOOST_DB_ACTION_ROWS,
  type TDbActionParamKind,
} from "./keys";

export interface ParamLevelScan {
  level: "row" | "rows" | "table";
  single: boolean;
  multi: boolean;
  hasRowParam: boolean;
  hasBody: boolean;
}

export function scanParamLevel(params: ReadonlyArray<Record<string, unknown>>): ParamLevelScan {
  let single = false;
  let multi = false;
  let hasRowParam = false;
  let hasBody = false;
  for (const p of params) {
    const kind = p[MOOST_DB_ACTION_PARAM] as TDbActionParamKind | undefined;
    if (kind === "pk") single = true;
    else if (kind === "pks") multi = true;
    if (p[MOOST_DB_ACTION_ROW]) {
      single = true;
      hasRowParam = true;
    }
    if (p[MOOST_DB_ACTION_ROWS]) {
      multi = true;
      hasRowParam = true;
    }
    if (p.paramSource === "BODY") hasBody = true;
  }
  const level = single && multi ? "table" : single ? "row" : multi ? "rows" : "table";
  return { level, single, multi, hasRowParam, hasBody };
}

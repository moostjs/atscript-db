import {
  MOOST_DB_ACTION_INPUT_FORM,
  MOOST_DB_ACTION_PARAM,
  MOOST_DB_ACTION_ROW,
  MOOST_DB_ACTION_ROWS,
  type TDbActionInputFormMeta,
  type TDbActionParamKind,
} from "./keys";

export interface ParamLevelScan {
  level: "row" | "rows" | "table";
  single: boolean;
  multi: boolean;
  hasRowParam: boolean;
  hasBody: boolean;
  inputForm?: TDbActionInputFormMeta;
  /** True when more than one `@InputForm()` param was found; only the first is honored. */
  hasDuplicateInputForm: boolean;
}

export function scanParamLevel(params: ReadonlyArray<Record<string, unknown>>): ParamLevelScan {
  let single = false;
  let multi = false;
  let hasRowParam = false;
  let hasBody = false;
  let inputForm: TDbActionInputFormMeta | undefined;
  let hasDuplicateInputForm = false;
  for (const p of params) {
    const kind = p[MOOST_DB_ACTION_PARAM] as TDbActionParamKind | undefined;
    if (kind === "id") single = true;
    else if (kind === "ids") multi = true;
    if (p[MOOST_DB_ACTION_ROW]) {
      single = true;
      hasRowParam = true;
    }
    if (p[MOOST_DB_ACTION_ROWS]) {
      multi = true;
      hasRowParam = true;
    }
    if (p.paramSource === "BODY") hasBody = true;
    const form = p[MOOST_DB_ACTION_INPUT_FORM] as TDbActionInputFormMeta | undefined;
    if (form) {
      if (inputForm) hasDuplicateInputForm = true;
      else inputForm = form;
    }
  }
  const level = single && multi ? "table" : single ? "row" : multi ? "rows" : "table";
  return { level, single, multi, hasRowParam, hasBody, inputForm, hasDuplicateInputForm };
}

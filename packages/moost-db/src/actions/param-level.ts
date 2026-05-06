import type { AtscriptDbParamsMeta } from "../mate";
import type { TDbActionInputFormMeta } from "./keys";

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

type ScannableParam = AtscriptDbParamsMeta & { paramSource?: string };

export function scanParamLevel(params: ReadonlyArray<ScannableParam>): ParamLevelScan {
  let single = false;
  let multi = false;
  let hasRowParam = false;
  let hasBody = false;
  let inputForm: TDbActionInputFormMeta | undefined;
  let hasDuplicateInputForm = false;
  for (const p of params) {
    if (p.atscript_db_action_param === "id") single = true;
    else if (p.atscript_db_action_param === "ids") multi = true;
    if (p.atscript_db_action_row) {
      single = true;
      hasRowParam = true;
    }
    if (p.atscript_db_action_rows) {
      multi = true;
      hasRowParam = true;
    }
    if (p.paramSource === "BODY") hasBody = true;
    if (p.atscript_db_action_input_form) {
      if (inputForm) hasDuplicateInputForm = true;
      else inputForm = p.atscript_db_action_input_form;
    }
  }
  const level = single && multi ? "table" : single ? "row" : multi ? "rows" : "table";
  return { level, single, multi, hasRowParam, hasBody, inputForm, hasDuplicateInputForm };
}

import { ApplyDecorators, Resolve, getMoostMate } from "moost";
import { current } from "@wooksjs/event-core";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { dbActionInputSlot } from "./input-form-cache";
import { type TDbActionInputFormMeta } from "./keys";

/**
 * Parameter decorator that injects the `input` field of the action request
 * envelope (`{ ids?, input? }`) into the handler.
 *
 * Pairs the resolved value with two pieces of param-level metadata:
 *
 * 1. `atscript_db_action_input_form` — the compiled `.as` class plus its
 *    name, consumed by `discoverActions` to:
 *    - emit `inputForm: FormType.name` on the action's `/meta` entry, and
 *    - register the type in the controller's form registry so
 *      `GET /meta/form/:name` can serve the serialized schema.
 * 2. `atscript_type` — just the type ref, providing a generic hook any
 *    atscript-aware Moost pipe can read without knowing about the
 *    moost-db-specific key.
 *
 * Validation is intentionally *not* performed here. To validate `input`
 * against `FormType`, install an atscript validator pipe globally
 * (`app.applyGlobalPipes(...)`) or scope it via `@Pipe(...)`. The pipe reads
 * `atscript_type` off the param and runs `FormType.validator()`.
 *
 * Only one `@InputForm()` per action is supported. To collect multiple
 * structured inputs, compose them into a single `.as` interface and pass an
 * array form on the field whose user-facing intent is "list of items".
 *
 * @param formType A compiled `.as` interface class (carries `.validator()`,
 *                 `.metadata`, etc.).
 */
export function InputForm<T extends TAtscriptAnnotatedType & { readonly name: string }>(
  formType: T,
): ParameterDecorator {
  const mate = getMoostMate();
  const meta: TDbActionInputFormMeta = { type: formType, name: formType.name };
  return ApplyDecorators(
    mate.decorate("atscript_db_action_input_form", meta),
    mate.decorate("atscript_type", formType),
    Resolve(async () => current().get(dbActionInputSlot), "dbActionInputForm"),
  );
}

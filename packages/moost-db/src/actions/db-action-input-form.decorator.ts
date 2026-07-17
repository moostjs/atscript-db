import { ApplyDecorators, Resolve, getMoostMate } from "moost";
import { current } from "@wooksjs/event-core";
import {
  isAnnotatedType,
  type TAtscriptAnnotatedType,
  type TValidatorOptions,
} from "@atscript/typescript/utils";

import { dbActionInputSlot } from "./input-form-cache";
import { type TDbActionInputFormMeta } from "./keys";

/** What `@InputForm` needs from a compiled `.as` interface. */
type TInputFormType = TAtscriptAnnotatedType & {
  readonly name: string;
  readonly validator: (opts?: Partial<TValidatorOptions>) => {
    validate: (value: unknown) => boolean;
  };
};

/** Human-readable description of a rejected form candidate for the error hint. */
function describeCandidate(candidate: unknown): string {
  if (candidate === undefined) {
    return "undefined — no reflected type (emitDecoratorMetadata off, or a circular import)";
  }
  if (candidate === Object) {
    return "Object — reflection lost the type (interface/union annotation, or the class was imported with `import type`)";
  }
  if (typeof candidate === "function") {
    return `class ${(candidate as { name?: string }).name ?? "<anonymous>"} — not a compiled .as interface`;
  }
  return typeof candidate;
}

/**
 * Parameter decorator that injects the `input` field of the action request
 * envelope (`{ ids?, input? }`) into the handler, **validated** against the
 * action's form.
 *
 * The form type may be passed explicitly — `@InputForm(MyForm)` — or inferred
 * from the parameter's reflected design type when omitted:
 *
 * ```ts
 * @Post("actions/comment")
 * @DbAction("comment", { label: "Comment" })
 * async comment(@InputForm() input: CommentForm) { ... }
 * ```
 *
 * Inference reads `design:paramtypes`, so it only works when the parameter is
 * annotated with the compiled `.as` class through a VALUE import — an
 * `import type` elides the class and reflection yields `Object`. When the
 * reflected type is unusable, decoration **throws** (fail-loud, at import
 * time) instead of silently serving an action without a form. The explicit
 * argument sidesteps reflection entirely and always wins over the annotation.
 *
 * The resolved form drives three things:
 *
 * 1. `atscript_db_action_input_form` — `{ type, name }` param metadata,
 *    consumed by `discoverActions` to emit `inputForm: <name>` on the
 *    action's `/meta` entry and to register the schema for
 *    `GET /meta/form/:name`.
 * 2. `atscript_type` — a generic hook any atscript-aware Moost pipe can read
 *    without knowing the moost-db-specific key.
 * 3. **Request-time validation** — the resolver runs
 *    `FormType.validator(opts).validate(input ?? {})` before the handler
 *    fires. A failure throws `ValidatorError`, which the controllers' own
 *    `validationErrorTransform` shapes into the same structured `400`
 *    envelope as strict-`ids` failures. Absent `input` is validated as `{}`
 *    (all-optional forms pass; required fields produce per-field errors) and
 *    the handler always receives an object, never `undefined`. Pass
 *    `validatorOpts` to tune validation; an app-level `validatorPipe()` may
 *    re-validate the same value harmlessly.
 *
 * Only one `@InputForm()` per action is supported. To collect multiple
 * structured inputs, compose them into a single `.as` interface and pass an
 * array form on the field whose user-facing intent is "list of items".
 *
 * @param formType A compiled `.as` interface class (carries `.validator()`,
 *                 `.metadata`, etc.). Optional — inferred from the param's
 *                 reflected type when omitted.
 * @param validatorOpts Options forwarded to `formType.validator()`.
 */
export function InputForm<T extends TAtscriptAnnotatedType & { readonly name: string }>(
  formType?: T,
  validatorOpts?: Partial<TValidatorOptions>,
): ParameterDecorator {
  const mate = getMoostMate();
  // Set at decoration time (explicit arg or inferred reflected type); read by
  // the request-time resolver below. Decoration throws when it can't be set.
  let resolved: TInputFormType | undefined;
  return ApplyDecorators(
    mate.decorate((paramMeta) => {
      const candidate: unknown = formType ?? paramMeta.type;
      if (
        !isAnnotatedType(candidate) ||
        typeof (candidate as { name?: unknown }).name !== "string" ||
        typeof (candidate as { validator?: unknown }).validator !== "function"
      ) {
        throw new Error(
          `@InputForm(${formType ? "…" : ""}) could not resolve the form type: expected a compiled .as ` +
            `interface, got ${describeCandidate(candidate)}. Annotate the parameter with the compiled ` +
            ".as class via a VALUE import, or pass the form explicitly: @InputForm(MyForm).",
        );
      }
      resolved = candidate as TInputFormType;
      const meta: TDbActionInputFormMeta = { type: resolved, name: resolved.name };
      return { ...paramMeta, atscript_db_action_input_form: meta, atscript_type: resolved };
    }),
    Resolve(async () => {
      const input = (await current().get(dbActionInputSlot)) ?? {};
      // `resolved` is always set — decoration throws otherwise. Validation
      // throws ValidatorError on mismatch → structured 400 via the
      // controllers' validationErrorTransform.
      if (resolved) {
        resolved.validator(validatorOpts).validate(input);
      }
      return input;
    }, "dbActionInputForm"),
  );
}

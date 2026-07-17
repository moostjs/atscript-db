import { describe, it, expect, beforeEach } from "vite-plus/test";
import { prepareTestHttpContext } from "@wooksjs/event-http";
import { ValidatorError } from "@atscript/typescript/utils";
import type { TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import { InputForm } from "../actions/db-action-input-form.decorator";
import { scanParamLevel } from "../actions/param-level";
import { getAtscriptDbMate } from "../mate";

/**
 * Unit coverage for the `@InputForm()` parameter decorator: metadata
 * stamping, form-type inference from `design:paramtypes` (with the fail-loud
 * decoration error), and request-time validation in the resolver. Two
 * `class` stubs mimic compiled atscript types — annotated marker + `name` +
 * `validator()` are all the decorator consumes.
 */

class CommentForm {
  note?: string;
  static __is_atscript_annotated_type = true as const;
  static validatedWith: unknown[] = [];
  static validatorOpts: unknown[] = [];
  static failWith: ValidatorError | undefined;
  static validator(opts?: unknown) {
    CommentForm.validatorOpts.push(opts);
    return {
      validate(value: unknown): boolean {
        CommentForm.validatedWith.push(value);
        if (CommentForm.failWith) {
          throw CommentForm.failWith;
        }
        return true;
      },
    };
  }
}

class AmountForm {
  amount?: number;
  static __is_atscript_annotated_type = true as const;
  static validator() {
    return { validate: (): boolean => true };
  }
}

type TFormToken = TAtscriptAnnotatedType & { name: string };

function readParamMate(target: object, methodName: string, paramIndex: number) {
  return getAtscriptDbMate().read(target, methodName)?.params?.[paramIndex];
}

beforeEach(() => {
  CommentForm.validatedWith = [];
  CommentForm.validatorOpts = [];
  CommentForm.failWith = undefined;
});

describe("@InputForm — param mate", () => {
  it("stamps atscript_db_action_input_form with `{ type, name }`", () => {
    class Ctrl {
      handler(_input: CommentForm) {
        void _input;
      }
    }
    InputForm(CommentForm as unknown as TFormToken)(Ctrl.prototype, "handler", 0);

    const meta = readParamMate(Ctrl.prototype, "handler", 0)?.atscript_db_action_input_form;
    expect(meta).toBeDefined();
    expect(meta?.name).toBe("CommentForm");
    expect(meta?.type).toBe(CommentForm);
  });

  it("also stamps the generic atscript_type key for pipe consumers", () => {
    class Ctrl {
      handler(_input: AmountForm) {
        void _input;
      }
    }
    InputForm(AmountForm as unknown as TFormToken)(Ctrl.prototype, "handler", 0);

    const param = readParamMate(Ctrl.prototype, "handler", 0);
    expect(param?.atscript_type).toBe(AmountForm);
  });
});

describe("@InputForm — form-type inference", () => {
  it("infers the form from the reflected param type when the arg is omitted", () => {
    class Ctrl {
      handler(@InputForm() _input: CommentForm) {
        void _input;
      }
    }

    const meta = readParamMate(Ctrl.prototype, "handler", 0)?.atscript_db_action_input_form;
    expect(meta?.type).toBe(CommentForm);
    expect(meta?.name).toBe("CommentForm");
  });

  it("explicit arg wins over a conflicting param annotation", () => {
    class Ctrl {
      handler(@InputForm(AmountForm as unknown as TFormToken) _input: CommentForm) {
        void _input;
      }
    }

    const meta = readParamMate(Ctrl.prototype, "handler", 0)?.atscript_db_action_input_form;
    expect(meta?.type).toBe(AmountForm);
    expect(meta?.name).toBe("AmountForm");
  });

  it("throws at decoration when the reflected type is not a compiled .as interface", () => {
    class PlainDto {
      note?: string;
    }
    expect(() => {
      class Ctrl {
        handler(@InputForm() _input: PlainDto) {
          void _input;
        }
      }
      void Ctrl;
    }).toThrow(/could not resolve the form type.*not a compiled \.as interface/s);
  });

  it("throws with the import-type hint when reflection yields Object", () => {
    expect(() => {
      class Ctrl {
        handler(@InputForm() _input: { note: string }) {
          void _input;
        }
      }
      void Ctrl;
    }).toThrow(/reflection lost the type.*import type/s);
  });
});

describe("@InputForm — level inference", () => {
  it("does not change the action's level (form-only action stays 'table')", () => {
    class Ctrl {
      handler(_input: CommentForm) {
        void _input;
      }
    }
    InputForm(CommentForm as unknown as TFormToken)(Ctrl.prototype, "handler", 0);

    const meta = getAtscriptDbMate().read(Ctrl.prototype, "handler");
    const scan = scanParamLevel(meta?.params ?? []);
    expect(scan.level).toBe("table");
    expect(scan.inputForm).toEqual({ type: CommentForm, name: "CommentForm" });
    expect(scan.hasRowParam).toBe(false);
  });
});

describe("@InputForm — resolver validates body.input", () => {
  function resolverOf(formType?: TFormToken, opts?: never) {
    class Ctrl {
      handler(_input: CommentForm) {
        void _input;
      }
    }
    InputForm(formType, opts)(Ctrl.prototype, "handler", 0);
    const resolver = readParamMate(Ctrl.prototype, "handler", 0)?.resolver as
      | (() => Promise<unknown>)
      | undefined;
    expect(typeof resolver).toBe("function");
    return resolver!;
  }

  function runInContext(rawBody: string, resolver: () => Promise<unknown>) {
    return prepareTestHttpContext({
      url: "/c/act",
      method: "POST",
      headers: { "content-type": "application/json" },
      rawBody,
    })(async () => resolver());
  }

  it("returns the validated `input` object on success", async () => {
    const resolver = resolverOf(CommentForm as unknown as TFormToken);
    const result = await runInContext('{"input":{"note":"hi"}}', resolver);
    expect(result).toEqual({ note: "hi" });
    expect(CommentForm.validatedWith).toEqual([{ note: "hi" }]);
  });

  it("rejects with ValidatorError when the form validation fails", async () => {
    CommentForm.failWith = new ValidatorError([{ path: "note", message: "Required" }]);
    const resolver = resolverOf(CommentForm as unknown as TFormToken);
    await expect(runInContext('{"input":{"bogus":1}}', resolver)).rejects.toBeInstanceOf(
      ValidatorError,
    );
    expect(CommentForm.validatedWith).toEqual([{ bogus: 1 }]);
  });

  it("validates absent `input` as {} and resolves to an object, never undefined", async () => {
    const resolver = resolverOf(CommentForm as unknown as TFormToken);
    const result = await runInContext('{"ids":{"id":"a"}}', resolver);
    expect(result).toEqual({});
    expect(CommentForm.validatedWith).toEqual([{}]);
  });

  it("forwards validatorOpts to formType.validator()", async () => {
    const opts = { partial: "deep" } as never;
    const resolver = resolverOf(CommentForm as unknown as TFormToken, opts);
    await runInContext('{"input":{"note":"x"}}', resolver);
    expect(CommentForm.validatorOpts).toEqual([opts]);
  });
});

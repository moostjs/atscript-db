import { describe, it, expect } from "vite-plus/test";

import * as main from "../index";
import * as validatorEntry from "../validator";
import { ClientError } from "../client-error";

// Since 0.1.165 the preflight's `ClientValidationError` is a `ClientError`
// (status 400, body `{ message, statusCode: 400, errors }`, `preflight: true`)
// and a runtime export of the main entry — one class shared with
// `@atscript/db-client/validator`. Before, it extended `Error` and the main
// entry exported only its type, so `instanceof ClientError` handlers missed it.

describe("ClientValidationError", () => {
  it("is exported as a value from the main entry — the same class as /validator", () => {
    expect(typeof (main as Record<string, unknown>).ClientValidationError).toBe("function");
    expect((main as Record<string, unknown>).ClientValidationError).toBe(
      validatorEntry.ClientValidationError,
    );
  });

  it("is a ClientError with status 400 and the server's envelope shape", () => {
    const errors = [{ path: "name", message: "Required" }];
    const error = new validatorEntry.ClientValidationError(errors);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ClientValidationError");
    expect(error.status).toBe(400);
    expect(error.preflight).toBe(true);
    expect(error.body).toEqual({ message: "Required", statusCode: 400, errors });
    expect(error.errors).toEqual(errors);
    expect(error.message).toBe("Required");
  });

  it("several errors summarise the message", () => {
    const error = new validatorEntry.ClientValidationError([
      { path: "a", message: "x" },
      { path: "b", message: "y" },
    ]);
    expect(error.message).toBe("Validation failed with 2 errors");
  });
});

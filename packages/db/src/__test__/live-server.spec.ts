import { describe, it, expect, afterEach } from "vite-plus/test";

import { liveServer } from "../../test-kit/live-server";

// The live suites' server helper (test-kit): nothing it reports may carry the
// connection string, host, user or password.

const ENV = "ATSCRIPT_LIVE_SERVER_SPEC_URL";
const URL_WITH_SECRETS = "postgresql://admin_user:s3cr%40t@db.internal.example:5432/postgres";

afterEach(() => {
  delete process.env[ENV];
});

describe("liveServer", () => {
  it("takes the first set variable, else the fallback", () => {
    expect(liveServer([ENV], "mysql://root:test@127.0.0.1:33071").url).toBe(
      "mysql://root:test@127.0.0.1:33071",
    );
    process.env[ENV] = URL_WITH_SECRETS;
    expect(liveServer(["ATSCRIPT_LIVE_SERVER_SPEC_UNSET", ENV], "x://y").url).toBe(
      URL_WITH_SECRETS,
    );
  });

  it("dbUrl swaps the path (none for an empty name)", () => {
    const server = liveServer([], "mysql://root:test@127.0.0.1:33071/app");
    expect(server.dbUrl("other")).toBe("mysql://root:test@127.0.0.1:33071/other");
    expect(server.dbUrl("")).toBe("mysql://root:test@127.0.0.1:33071");
  });

  it("redacts the URL, password (raw and decoded), user and host", () => {
    process.env[ENV] = URL_WITH_SECRETS;
    const server = liveServer([ENV], "x://y");
    const text = `connect to ${URL_WITH_SECRETS} failed: password "s3cr@t" (s3cr%40t) for user "admin_user" at db.internal.example`;
    const redacted = server.redact(text);
    for (const secret of ["s3cr", "admin_user", "db.internal.example", "postgresql://"]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toBe(
      'connect to <server-url> failed: password "<password>" (<password>) for user "<user>" at <host>',
    );
  });

  it("a password that is not valid percent-encoding still masks password, user and host", () => {
    process.env[ENV] = "postgresql://admin_user:p%zzword@db.internal.example:5432/postgres";
    const server = liveServer([ENV], "x://y");
    expect(server.redact('password p%zzword for user "admin_user" at db.internal.example')).toBe(
      'password <password> for user "<user>" at <host>',
    );
  });

  it("error() keeps the redacted message only — never the driver error's properties", () => {
    process.env[ENV] = URL_WITH_SECRETS;
    const server = liveServer([ENV], "x://y");
    const driverError = Object.assign(new Error("login failed for admin_user"), {
      config: { connectionString: URL_WITH_SECRETS, password: "s3cr@t" },
    });
    const error = server.error("admin statement failed", driverError);
    expect(error.message).toBe("admin statement failed: login failed for <user>");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("s3cr");
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("config");
  });

  it("an invalid URL throws without echoing it", () => {
    process.env[ENV] = "not a url but-a-secret";
    const server = liveServer([ENV], "x://y");
    let thrown: unknown;
    try {
      server.dbUrl("db");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(`${ENV} is not a valid URL`);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain("secret");
  });
});

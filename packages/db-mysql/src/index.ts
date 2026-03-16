import { DbSpace } from "@atscript/db";

import { MysqlAdapter } from "./mysql-adapter";
import { Mysql2Driver } from "./mysql2-driver";

export { MysqlAdapter } from "./mysql-adapter";
export { Mysql2Driver } from "./mysql2-driver";
export { MysqlPlugin } from "./plugin/index";
export { buildWhere } from "./filter-builder";
export type { TSqlFragment } from "./filter-builder";
export type { TMysqlDriver, TMysqlRunResult, TMysqlConnection } from "./types";

/**
 * Creates a {@link DbSpace} backed by a MySQL connection pool.
 *
 * @param uri - MySQL connection URI (e.g., `mysql://root@localhost:3306/mydb`)
 * @param options - Additional pool options passed to mysql2.
 * @returns A `DbSpace` that creates `MysqlAdapter` instances per table.
 */
export function createAdapter(uri: string, options?: Record<string, unknown>): DbSpace {
  const driver = new Mysql2Driver({ uri, ...options } as any);
  return new DbSpace(() => new MysqlAdapter(driver));
}

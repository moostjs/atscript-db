import path from "path";

import { prepareFixtures as prepare } from "@atscript/typescript/test-utils";
import dbPlugin from "@atscript/db/plugin";
import MongoPlugin from "../../plugin/index";
import { createAdapter } from "../index";

export async function prepareFixtures() {
  const fixturesDir = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  await prepare({
    rootDir: fixturesDir,
    plugins: [dbPlugin(), MongoPlugin()],
  });
}

export function createTestSpace() {
  return createAdapter("mongodb+srv://dummy:dummy@test.jd1qx.mongodb.net/test?");
}

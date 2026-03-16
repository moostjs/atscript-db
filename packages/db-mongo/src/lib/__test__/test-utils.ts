import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { build } from "@atscript/core";
import { tsPlugin as ts } from "@atscript/typescript";
import dbPlugin from "@atscript/db/plugin";
import MongoPlugin from "../../plugin/index";
import { createAdapter } from "../index";

export async function prepareFixtures() {
  const wd = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  const repo = await build({
    rootDir: wd,
    include: ["**/*.as"],
    plugins: [ts(), dbPlugin(), MongoPlugin()],
  });
  const out = await repo.generate({
    outDir: ".",
    format: "js",
  });
  const outDts = await repo.generate({
    outDir: ".",
    format: "dts",
  });
  for (const file of [...out, ...outDts]) {
    if (existsSync(file.target)) {
      const content = readFileSync(file.target).toString();
      if (content !== file.content) {
        writeFileSync(file.target, file.content);
      }
    } else {
      writeFileSync(file.target, file.content);
    }
  }
}

export function createTestSpace() {
  return createAdapter("mongodb+srv://dummy:dummy@test.jd1qx.mongodb.net/test?");
}

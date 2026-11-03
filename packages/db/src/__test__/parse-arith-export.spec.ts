import { describe, it, expect } from "vite-plus/test";

import { parseArith } from "../index";

// `parseArith` is re-exported from `@atscript/db` (since 0.1.168): an
// aggregate `$expr` built in code can be written as text.

describe("parseArith (re-exported from @uniqu/core)", () => {
  it("turns a weighted sum into the binary node tree $expr takes", () => {
    expect(parseArith("a*1 + b*4 + c*0.1")).toEqual({
      $op: "+",
      $args: [
        {
          $op: "+",
          $args: [
            { $op: "*", $args: ["a", 1] },
            { $op: "*", $args: ["b", 4] },
          ],
        },
        { $op: "*", $args: ["c", 0.1] },
      ],
    });
  });
});

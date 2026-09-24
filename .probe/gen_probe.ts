import { GENERATOR as TS } from "skir-typescript-gen";
import { GENERATOR as PY } from "skir-python-gen";
import { ModuleSet } from "../src/module_set.js";

const code = `
struct Point { x: int32; y: int32; }
struct User(1) {
  id: int32;
  name: string;
  tags: [string];
  location: Point?;
}
enum Status { ACTIVE; suspended: string; removed; }
method GetUser(int32): User = 1001;
`;
const map = new Map([["demo/user.skir", code]]);
const ms = ModuleSet.compile(map, "no-cache", "strict");
console.log("errors", ms.errors.length);
const input = { modules: [...ms.modules.values()].map(r => r.result), recordMap: ms.recordMap, config: {} };
for (const [n, g] of [["ts", TS], ["py", PY]] as const) {
  const out = g.generateCode(input);
  console.log(n, JSON.stringify(out.files.map(f => f.path)));
}

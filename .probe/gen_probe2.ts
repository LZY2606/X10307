import { GENERATOR as TS } from "skir-typescript-gen";
import { ModuleSet } from "../src/module_set.js";
import * as fs from "fs";

const code = `
struct User(1) {
  id: int32;
  name: string;
  tags: [string];
  nickname?: string;
}
enum Color { RED; GREEN; BLUE; with_payload: string; }
`;
const map = new Map([["demo/user.skir", code]]);
const ms = ModuleSet.compile(map, "no-cache", "strict");
const input = { modules: [...ms.modules.values()].map(r => r.result), recordMap: ms.recordMap, config: {} };
const out = TS.generateCode(input);
fs.mkdirSync(".probe/out", { recursive: true });
for (const f of out.files) fs.writeFileSync(".probe/out/" + f.path.split("/").pop()!, f.code);
console.log(out.files.map(f=>f.path));

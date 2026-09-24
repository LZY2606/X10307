import { ModuleSet } from "./src/module_set.js";
import { GENERATOR } from "skir-typescript-gen";

const a = `
  import * as b from "./b.skir";
  struct A(101) { b: b.B; name: string; }
  enum E(103) { x; y: int32; }
  method Hello(A): string = 201;
`;
const b = `struct B(102) { x: int32; }`;

function compile(paths: string[]) {
  const map = new Map<string, string>();
  for (const p of paths) map.set(p, p === "a.skir" ? a : b);
  return ModuleSet.compile(map, "no-cache", "strict");
}

function gen(ms: ModuleSet) {
  const out = GENERATOR.generateCode({
    modules: [...ms.modules.values()].map((r) => r.result),
    recordMap: ms.recordMap,
    config: GENERATOR.configType.parse({}),
  });
  return out.files.map((f) => f.path + " #" + f.code.length).join("\n");
}

const ms1 = compile(["a.skir", "b.skir"]);
const ms2 = compile(["b.skir", "a.skir"]);
console.log("errors:", ms1.errors.length, ms2.errors.length);
const g1 = gen(ms1);
const g2 = gen(ms2);
console.log("same output:", g1 === g2);
console.log(g1);

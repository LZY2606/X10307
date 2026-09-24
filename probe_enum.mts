import { ModuleSet } from "./src/module_set.js";
const ms = ModuleSet.compile(new Map([["m.skir", `enum E(102) { a; b: string; c: int32; }`]]), "no-cache", "strict");
for (const [p, r] of ms.modules) {
  for (const rec of r.result.records) {
    for (const f of rec.record.fields) console.log(f.name.text, f.number, f.type?.kind);
  }
}

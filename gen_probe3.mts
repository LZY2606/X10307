import { ModuleSet } from "./src/module_set.js";
const variants: Record<string, string> = {
  enum: `enum E(103) { X; Y: int32; }`,
  method: `method Hello(string): string = 201;`,
};
for (const [k, src] of Object.entries(variants)) {
  const ms = ModuleSet.compile(new Map([["a.skir", src]]), "no-cache", "strict");
  console.log(k, "errors:", ms.errors, ms.warnings);
}

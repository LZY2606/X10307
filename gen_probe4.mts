import { ModuleSet } from "./src/module_set.js";
const pkgs = ["skir-cc-gen","skir-csharp-gen","skir-dart-gen","skir-gleam-gen","skir-go-gen","skir-rust-gen","skir-swift-gen","skir-typescript-gen","skir-zig-gen"];
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
const ms1 = compile(["a.skir", "b.skir"]);
const ms2 = compile(["b.skir", "a.skir"]);
for (const pkg of pkgs) {
  try {
    const { GENERATOR } = await import(pkg);
    const cfg = GENERATOR.configType.parse({});
    const run = (ms: any) => GENERATOR.generateCode({
      modules: [...ms.modules.values()].map((r: any) => r.result),
      recordMap: ms.recordMap,
      config: cfg,
    }).files.map((f: any) => f.path + "#" + f.code.length).join("|");
    const g1 = run(ms1), g2 = run(ms2);
    console.log(pkg, "files:", g1.split("|").length, "deterministic:", g1 === g2);
  } catch (e) {
    console.log(pkg, "ERROR:", String(e).slice(0, 120));
  }
}

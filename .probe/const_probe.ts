import { ModuleSet } from "../src/module_set.js";
const code = `
struct Point { x: int32; y: int32; }
enum Color { RED; GREEN; msg: string; }
struct User(1) { id: int32; name: string; color: Color; points: [Point|x]; nickname: string?; }
const DEFAULT_USER: User = {
  id: 7,
  name: "ada",
  color: { kind: "msg", value: "hi" },
  points: [{x: 1, y: 2}, {x: 3, y: 4}],
  nickname: null,
};
const GOLDEN: User = { id: 1, name: "x", color: "RED", points: [], nickname: "n" };
`;
const ms = ModuleSet.compile(new Map([["f.skir", code]]), "no-cache", "strict");
console.log("errors", ms.errors.map(e=>e.message??e.expected));
const mod = ms.modules.get("f.skir")!.result;
for (const c of mod.constants) console.log(c.name.text, JSON.stringify(c.valueAsDenseJson));

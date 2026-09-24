import { GENERATOR as TS } from "skir-typescript-gen";
import { ModuleSet } from "../src/module_set.js";

function tryGen(code: string, label: string) {
  const map = new Map([["demo/user.skir", code]]);
  const ms = ModuleSet.compile(map, "no-cache", "strict");
  if (ms.errors.length) { console.log(label, "PARSE ERR", ms.errors.map(e=>e.message??e.expected).join(";")); return; }
  const input = { modules: [...ms.modules.values()].map(r => r.result), recordMap: ms.recordMap, config: {} };
  try {
    const out = TS.generateCode(input);
    console.log(label, "OK", out.files.length);
  } catch (e: any) {
    console.log(label, "GEN ERR", e.message.split("\n")[0]);
  }
}
tryGen(`struct User(1) { id: int32; name: string; nickname?: string; }`, "optional");
tryGen(`enum Color { RED; GREEN; BLUE; with_payload: string; }`, "enum4");
tryGen(`enum Color { RED; GREEN; with_payload: string; }`, "enum3");
tryGen(`struct User(1) { id: int32; name: string; tags: [string]; } enum Color { RED; GREEN; with_payload: string; }`, "both");

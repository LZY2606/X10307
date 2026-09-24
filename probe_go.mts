import { GENERATOR } from "skir-go-gen";
console.log(GENERATOR.id);
const cfg = GENERATOR.configType.parse({ goModuleName: "example.com/skirtest" });
console.log("ok", JSON.stringify(cfg));

import { GENERATOR } from "skir-typescript-gen";
console.log("id:", GENERATOR.id);
try {
  const cfg = GENERATOR.configType.parse({});
  console.log("config ok:", JSON.stringify(cfg));
} catch (e) {
  console.log("config err:", String(e.message).slice(0, 300));
}

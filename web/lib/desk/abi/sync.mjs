// Regenerates the typed ABI modules in this folder from the frozen interface snapshot in contracts/abi.
// Run from anywhere after refreshing the snapshot (see contracts/abi/README.md):
//   node web/lib/desk/abi/sync.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const targets = [
  ["IDeskLane", "deskLaneAbi", "DeskLane.ts"],
  ["IDeskLaneFactory", "deskLaneFactoryAbi", "DeskLaneFactory.ts"],
  ["IPriceFence", "priceFenceAbi", "PriceFence.ts"],
];

for (const [src, name, file] of targets) {
  const abi = JSON.parse(fs.readFileSync(path.join(root, "contracts/abi", `${src}.json`), "utf8"));
  const body =
    `// GENERATED from contracts/abi/${src}.json (the FROZEN M2 interface snapshot). Do not edit by hand.\n` +
    `// Regenerate: node web/lib/desk/abi/sync.mjs\n\n` +
    `export const ${name} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  fs.writeFileSync(path.join(here, file), body);
  console.log(`${file}: ${abi.length} entries`);
}

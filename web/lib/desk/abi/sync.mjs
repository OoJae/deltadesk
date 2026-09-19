// Regenerates the typed ABI modules in this folder from the frozen interface snapshot in contracts/abi, plus the
// implementation-only items the web needs from contracts/abi/extras.json (contracts/scripts/abi-extras.py): every
// custom error and event, so viem decodes any revert or log by name, and the few implementation views the wizard
// reads. Run from anywhere after refreshing the snapshot (see contracts/abi/README.md):
//   node web/lib/desk/abi/sync.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const extras = JSON.parse(fs.readFileSync(path.join(root, "contracts/abi/extras.json"), "utf8"));
// [interface snapshot, extras.json key, implementation functions to add, export name, file]
const targets = [
  ["IDeskLane", "lane", [], "deskLaneAbi", "DeskLane.ts"],
  // listed(lane): the owner confirmed the lane (it is in lanesOf); pendingImplementation(kind): a replacement that
  // would move every predicted address once applied.
  ["IDeskLaneFactory", "factory", ["listed", "pendingImplementation", "IMPLEMENTATION_DELAY"], "deskLaneFactoryAbi", "DeskLaneFactory.ts"],
  ["IPriceFence", "fence", [], "priceFenceAbi", "PriceFence.ts"],
];

for (const [src, key, fns, name, file] of targets) {
  const frozen = JSON.parse(fs.readFileSync(path.join(root, "contracts/abi", `${src}.json`), "utf8"));
  const extra = extras[key];
  if (!Array.isArray(extra)) throw new Error(`contracts/abi/extras.json has no "${key}" list`);
  const missing = fns.filter((f) => !extra.some((x) => x.type === "function" && x.name === f));
  if (missing.length) throw new Error(`contracts/abi/extras.json "${key}" lacks ${missing.join(", ")}`);
  const added = extra.filter((x) => x.type === "error" || x.type === "event" || (x.type === "function" && fns.includes(x.name)));
  const abi = [...frozen, ...added];
  const body =
    `// GENERATED from contracts/abi/${src}.json (the FROZEN M2 interface snapshot) plus the "${key}" errors, events and\n` +
    `// ${fns.length ? `views (${fns.join(", ")})` : "no views"} from contracts/abi/extras.json. Do not edit by hand.\n` +
    `// Regenerate: node web/lib/desk/abi/sync.mjs\n\n` +
    `export const ${name} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  fs.writeFileSync(path.join(here, file), body);
  console.log(`${file}: ${frozen.length} interface + ${added.length} extras entries`);
}

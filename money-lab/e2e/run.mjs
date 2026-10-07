// Builds the runtime, then runs one offline end-to-end scenario against fake
// APIs, so a check never exercises a stale dist/. No real network, no cost.
//
//   node money-lab/e2e/run.mjs harness   (pnpm run build && node money-lab/e2e/harness.mjs)
//   node money-lab/e2e/run.mjs chaos     (pnpm run build && node money-lab/e2e/chaos.mjs)
import { spawnSync } from "child_process";
import path from "path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, "..", "..");
const SCENARIOS = { harness: "harness.mjs", chaos: "chaos.mjs" };

const name = process.argv[2];
if (!SCENARIOS[name]) {
  console.error(`usage: node money-lab/e2e/run.mjs ${Object.keys(SCENARIOS).join("|")}`);
  process.exit(2);
}

const step = (cmd, args) => {
  const res = spawnSync(cmd, args, { cwd: REPO, stdio: "inherit" });
  if (res.error) {
    console.error(`${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
};

step("pnpm", ["run", "build"]);
step(process.execPath, [path.join(HERE, SCENARIOS[name])]);

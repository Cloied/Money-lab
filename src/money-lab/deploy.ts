/**
 * Money Lab site deployment to Cloudflare Pages (step 5b)
 *
 * GitHub Pages serves one site per repository; Cloudflare Pages adds free
 * hosting with its own CDN, unlimited bandwidth, 500 deployments a month and
 * https://<project>.pages.dev, which the owner can later point a domain to.
 * The runtime drives the wrangler CLI with a token scoped to Cloudflare Pages
 * (CLOUDFLARE_PAGES_TOKEN, sealed): the token reaches only that command's
 * environment, never the agent's shell.
 */

import fs from "fs";
import path from "path";
import { runLocalCommand, scrubbedEnv, shellQuote, withSecrets } from "./selfhosted.js";
import type { ExecResult } from "../types.js";

export const MAX_DEPLOYS_PER_DAY = 10;
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/;

export function cloudflarePagesConfigured(env: NodeJS.ProcessEnv = withSecrets()): boolean {
  return Boolean(env.CLOUDFLARE_PAGES_TOKEN?.trim() && env.CLOUDFLARE_ACCOUNT_ID?.trim());
}

/** The wrangler command: MONEY_LAB_WRANGLER, a wrangler on PATH, else npx (downloads it the first time). */
export function wranglerCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MONEY_LAB_WRANGLER && fs.existsSync(env.MONEY_LAB_WRANGLER)) return shellQuote(env.MONEY_LAB_WRANGLER);
  for (const dir of (env.PATH || "").split(":").filter(Boolean)) {
    if (fs.existsSync(path.join(dir, "wrangler"))) return "wrangler";
  }
  return "npx --yes wrangler@4";
}

/** The environment of a wrangler command: scrubbed, plus the Cloudflare token under the name wrangler reads. */
export function wranglerEnv(env: NodeJS.ProcessEnv = withSecrets()): NodeJS.ProcessEnv {
  return {
    ...scrubbedEnv(env),
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_PAGES_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG: "error",
  };
}

export interface DeployArgs {
  name: string;
  dir?: string;
}

export interface DeployOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<ExecResult>;
}

/**
 * Deploys ~/sites/<name> (or dir) as the Cloudflare Pages project <name>:
 * creates the project when missing, uploads the files, returns the URLs.
 */
export async function deploySite(args: DeployArgs, options: DeployOptions): Promise<string> {
  const env = options.env ?? withSecrets();
  if (!cloudflarePagesConfigured(env)) {
    return "Cloudflare Pages is not configured (CLOUDFLARE_PAGES_TOKEN and CLOUDFLARE_ACCOUNT_ID): publish with GitHub Pages, or ask the owner (guide, Cloudflare Pages).";
  }
  const name = String(args.name ?? "").trim().toLowerCase();
  if (!PROJECT_NAME.test(name)) return "name: 2-58 lowercase letters, digits or dashes (it becomes <name>.pages.dev).";
  const home = fs.realpathSync(options.home);
  const dir = path.resolve(home, (args.dir ?? `~/sites/${name}`).replace(/^~(?=$|\/)/, home));
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return `${dir} does not exist: scaffold_site first, or give dir.`;
  }
  if (!real.startsWith(home + path.sep)) return "dir must be inside your home directory.";
  if (!fs.existsSync(path.join(real, "index.html"))) return `${real} has no index.html: deploy a finished static site.`;
  const run = options.run ?? runLocalCommand;
  const cmdEnv = wranglerEnv(env);
  const wrangler = wranglerCommand(env);
  const notes: string[] = [];
  const create = await run(`${wrangler} pages project create ${shellQuote(name)} --production-branch main 2>&1`, 180_000, cmdEnv);
  const createOut = `${create.stdout}\n${create.stderr}`;
  if (create.exitCode === 0) notes.push(`project ${name} created`);
  else if (/already exists|8000017|duplicate/i.test(createOut)) notes.push(`project ${name} exists`);
  else return `Cloudflare Pages: could not create the project (exit ${create.exitCode}): ${createOut.trim().slice(-400)}`;
  const deploy = await run(`cd ${shellQuote(real)} && ${wrangler} pages deploy . --project-name ${shellQuote(name)} --branch main --commit-dirty=true 2>&1`, 600_000, cmdEnv);
  const out = `${deploy.stdout}\n${deploy.stderr}`;
  if (deploy.exitCode !== 0) return `Cloudflare Pages: deployment failed (exit ${deploy.exitCode}): ${out.trim().slice(-600)}`;
  const urls = [...new Set(out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev\/?/gi) ?? [])];
  const production = `https://${name}.pages.dev/`;
  return [
    `Deployed ${real} to Cloudflare Pages (${notes.join(", ")}).`,
    `Site: ${production}${urls.length ? ` (this deployment: ${urls[0]})` : ""}`,
    "Next: monitor_site add, probe or Search Console on this URL; tell the owner the domain to point here when it earns one.",
  ].join("\n");
}

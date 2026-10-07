/**
 * Money Lab bundled assets
 *
 * The runtime ships files the agent works with: skills (SKILL.md) and the
 * design kit (CSS, templates). They live in the runtime code tree, which
 * the agent cannot read, so each start copies them into the agent's home:
 * skills into the skills directory, the kit into ~/library/design. A copy
 * is refreshed when the bundled file changed; the agent's own files next to
 * them are never touched, and a bundled file the agent edited is kept until
 * the bundle changes (the bundle then wins: it is the newer method).
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { RUNTIME_ROOT } from "./guard.js";

export const DESIGN_KIT_DIR = path.join("library", "design");
const STAMP = ".bundle-hashes.json";

function bundleRoot(): string {
  return path.join(RUNTIME_ROOT, "money-lab");
}

function listFiles(dir: string, out: string[] = [], base = dir): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out, base);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

function hash(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Copies `src` into `dst`. Files whose bundled hash is unchanged since the
 * last copy are left alone (the agent may have edited them); changed or
 * new bundled files are written. Returns the relative paths written.
 */
export function syncBundle(src: string, dst: string): string[] {
  if (!fs.existsSync(src)) return [];
  fs.mkdirSync(dst, { recursive: true });
  const stampFile = path.join(dst, STAMP);
  let stamps: Record<string, string> = {};
  try {
    stamps = JSON.parse(fs.readFileSync(stampFile, "utf-8"));
  } catch {
    // first copy
  }
  const written: string[] = [];
  for (const rel of listFiles(src)) {
    const data = fs.readFileSync(path.join(src, rel));
    const h = hash(data);
    const target = path.join(dst, rel);
    if (stamps[rel] === h && fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Never follow a link the agent could have planted at the target path.
    try {
      if (fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target);
    } catch {
      // absent
    }
    fs.writeFileSync(target, data);
    stamps[rel] = h;
    written.push(rel);
  }
  fs.writeFileSync(stampFile, JSON.stringify(stamps, null, 1));
  return written;
}

/** Installs the bundled skills and the design kit; returns what changed. */
export function installBundledAssets(home: string, skillsDir: string): { skills: string[]; kit: string[] } {
  const root = bundleRoot();
  const skills: string[] = [];
  const skillsRoot = path.join(root, "skills");
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const written = syncBundle(path.join(skillsRoot, entry.name), path.join(skillsDir, entry.name));
      if (written.length) skills.push(entry.name);
    }
  }
  const kit = syncBundle(path.join(root, "design-kit"), path.join(home, DESIGN_KIT_DIR));
  return { skills, kit };
}

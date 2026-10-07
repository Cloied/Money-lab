/**
 * Money Lab publication kits
 *
 * Owner plan (2026-10-07), step 4: the agent cannot post on directories,
 * forums or groups (no accounts, no prospecting), but the owner will post
 * for it, provided nothing is left to write. A kit is one ready-to-paste
 * publication for one venue: the exact place, the title, the text, the
 * tracking link, the image, the venue's rules and what readers gain. The
 * owner receives it on Telegram, posts it in their own name, then confirms
 * with /publie <id> [url] (or /passe <id> [reason]); the agent is woken to
 * follow the traffic. Limits keep the owner's inbox usable: at most 5
 * pending kits, 3 drafted a day; a kit expires after 14 days.
 */

import type Database from "better-sqlite3";
import { getKV, queueOwnerNotification, setKV } from "./journal.js";

const KITS_KEY = "money_lab.kits";
export const MAX_PENDING_KITS = 5;
export const MAX_KITS_PER_DAY = 3;
const EXPIRE_MS = 14 * 86_400_000;
const MAX_STORED = 150;
const MAX_BODY = 2500;

export type KitStatus = "pending" | "posted" | "skipped" | "expired";

export interface Kit {
  id: string;
  status: KitStatus;
  createdAt: string;
  platform: string;
  where: string;
  audience: string;
  title: string;
  body: string;
  link: string;
  image?: string;
  rules: string;
  value: string;
  decidedAt?: string;
  postedUrl?: string;
  note?: string;
}

export function listKits(db: Database.Database): Kit[] {
  try {
    const raw = JSON.parse(getKV(db, KITS_KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as Kit[]) : [];
  } catch {
    return [];
  }
}

function save(db: Database.Database, kits: Kit[]): void {
  setKV(db, KITS_KEY, JSON.stringify(kits.slice(-MAX_STORED)));
}

function text(value: unknown, max = 400): string {
  return String(value ?? "").trim().slice(0, max);
}

/** GoatCounter records ?ref= as the referrer: every kit gets its own. */
export function trackingLink(link: string, id: string): string | null {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.searchParams.set("ref", `kit-${id}`);
    return url.toString();
  } catch {
    return null;
  }
}

/** Pending kits past their expiry are marked expired. */
export function expireKits(db: Database.Database, now = new Date()): void {
  const kits = listKits(db);
  let changed = false;
  for (const kit of kits) {
    if (kit.status === "pending" && now.getTime() - Date.parse(kit.createdAt) > EXPIRE_MS) {
      kit.status = "expired";
      kit.decidedAt = now.toISOString();
      changed = true;
    }
  }
  if (changed) save(db, kits);
}

export function draftKit(db: Database.Database, input: Record<string, unknown>, now = new Date()): Kit | string {
  expireKits(db, now);
  const kits = listKits(db);
  const pending = kits.filter((k) => k.status === "pending");
  if (pending.length >= MAX_PENDING_KITS) return `The owner already has ${pending.length} kits waiting: wait for /publie or /passe before drafting more.`;
  const today = now.toISOString().slice(0, 10);
  if (kits.filter((k) => k.createdAt.slice(0, 10) === today).length >= MAX_KITS_PER_DAY) return `At most ${MAX_KITS_PER_DAY} kits a day: the owner's time is limited. Draft the next one tomorrow.`;
  const platform = text(input.platform, 60);
  const where = text(input.where, 300);
  const title = text(input.title, 150);
  const body = text(input.body, MAX_BODY);
  const rules = text(input.rules, 500);
  const value = text(input.value, 300);
  const audience = text(input.audience, 200);
  if (!platform || !where || !title || !body || !rules || !value) {
    return "A kit needs platform, where (the exact page or group URL), title, body (ready to paste, nothing left to write), rules (what this venue allows and forbids) and value (what readers gain).";
  }
  if (!/^https?:\/\//.test(where)) return "where must be the URL of the exact place to post (a subreddit, a directory's submit page, a group).";
  if (body.length < 120) return "body is too short to be worth the owner's time: write the full text (120+ characters), in the venue's language.";
  const id = `k${now.getTime().toString(36).slice(-6)}`;
  const link = input.link ? trackingLink(String(input.link), id) : null;
  if (input.link && !link) return "link must be an http(s) URL (your page); it receives ?ref=kit-<id> so visits are attributed.";
  // The same text twice is spam, whatever the venue.
  const duplicate = kits.find((k) => k.body.slice(0, 200) === body.slice(0, 200));
  if (duplicate) return `This text was already used in kit ${duplicate.id} (${duplicate.platform}): write for this venue, do not paste the same post twice.`;
  const kit: Kit = {
    id, status: "pending", createdAt: now.toISOString(), platform, where, audience, title,
    body: link ? body.split(String(input.link)).join(link) : body, link: link ?? "", image: input.image ? text(input.image, 200) : undefined, rules, value,
  };
  kits.push(kit);
  save(db, kits);
  queueOwnerNotification(db, formatKitForOwner(kit));
  return kit;
}

/** The message the owner receives: everything to copy, nothing to write. */
export function formatKitForOwner(kit: Kit): string {
  return [
    `📣 Kit de publication ${kit.id} — ${kit.platform}`,
    `Où : ${kit.where}`,
    kit.audience ? `Pour qui : ${kit.audience}` : "",
    `Ce que ça apporte : ${kit.value}`,
    `Règles du lieu : ${kit.rules}`,
    "",
    "— Titre à coller —",
    kit.title,
    "",
    "— Texte à coller —",
    kit.body,
    kit.link && !kit.body.includes(kit.link) ? `\nLien : ${kit.link}` : "",
    kit.image ? `Image : ${kit.image} (sur le serveur)` : "",
    "",
    `Quand c'est publié : /publie ${kit.id} <lien du post>. Pour passer : /passe ${kit.id} [raison].`,
  ].filter((l) => l !== "").join("\n");
}

export function decideKit(db: Database.Database, id: string, posted: boolean, note: string, now = new Date()): string {
  const kits = listKits(db);
  const kit = kits.find((k) => k.id === id.trim().toLowerCase());
  if (!kit) return `Kit ${id} introuvable (/kits pour la liste).`;
  if (kit.status !== "pending") return `Kit ${id} déjà traité (${kit.status}).`;
  kit.status = posted ? "posted" : "skipped";
  kit.decidedAt = now.toISOString();
  if (posted && /^https?:\/\//.test(note.trim())) kit.postedUrl = note.trim().split(/\s+/)[0];
  else if (note.trim()) kit.note = note.trim().slice(0, 300);
  save(db, kits);
  return posted
    ? `Kit ${id} marqué publié${kit.postedUrl ? ` (${kit.postedUrl})` : ""}. Le bot suivra les visites (ref=kit-${id}).`
    : `Kit ${id} passé${kit.note ? ` (${kit.note})` : ""}. Le bot en tiendra compte.`;
}

export function describeKits(db: Database.Database, options: { pendingOnly?: boolean; limit?: number } = {}): string {
  const kits = listKits(db).filter((k) => !options.pendingOnly || k.status === "pending").slice(-(options.limit ?? 10));
  if (kits.length === 0) return options.pendingOnly ? "Aucun kit en attente." : "No kit yet.";
  return kits.map((k) =>
    `${k.id} [${k.status}] ${k.createdAt.slice(0, 10)} ${k.platform}: ${k.title.slice(0, 70)}` +
    `${k.postedUrl ? ` → ${k.postedUrl}` : ""}${k.note ? ` (${k.note.slice(0, 60)})` : ""}`).join("\n");
}

/** One line for the prompt. */
export function describeKitsForPrompt(db: Database.Database): string {
  const kits = listKits(db);
  if (kits.length === 0) return "none yet";
  const count = (s: KitStatus) => kits.filter((k) => k.status === s).length;
  const posted = kits.filter((k) => k.status === "posted").slice(-3).map((k) => `${k.id} ${k.platform} (ref=kit-${k.id})`);
  return `${count("pending")} waiting for the owner, ${count("posted")} posted${posted.length ? ` (${posted.join("; ")})` : ""}, ${count("skipped")} skipped, ${count("expired")} expired`;
}

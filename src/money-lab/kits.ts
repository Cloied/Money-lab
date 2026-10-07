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
 *
 * Step 5b: when the owner gave the bot a dev.to key or a Mastodon token, a
 * kit for that venue is published by the runtime itself once the owner
 * answers /publie (nothing to paste); the agent never sees the tokens.
 */

import type Database from "better-sqlite3";
import { getKV, queueOwnerNotification, setKV } from "./journal.js";
import { withSecrets } from "./selfhosted.js";

const KITS_KEY = "money_lab.kits";
export const MAX_PENDING_KITS = 5;
export const MAX_KITS_PER_DAY = 3;
const EXPIRE_MS = 14 * 86_400_000;
const MAX_STORED = 150;
const MAX_BODY = 2500;

export type KitStatus = "pending" | "approved" | "posted" | "skipped" | "expired" | "failed";
export type KitChannel = "devto" | "mastodon";
const MASTODON_MAX = 500;

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
  /** Set when the runtime can publish this kit itself after /publie. */
  channel?: KitChannel;
  tags?: string[];
  decidedAt?: string;
  postedUrl?: string;
  note?: string;
}

/** The venue the runtime can post to itself, when the owner configured it. */
export function kitChannel(platform: string, env: NodeJS.ProcessEnv = withSecrets()): KitChannel | null {
  if (/\bdev\.to\b|\bdevto\b/i.test(platform) && env.DEVTO_API_KEY?.trim()) return "devto";
  if (/mastodon|piaille|mamot|\.social\b/i.test(platform) && env.MASTODON_INSTANCE?.trim() && env.MASTODON_TOKEN?.trim()) return "mastodon";
  return null;
}

export function kitChannelsConfigured(env: NodeJS.ProcessEnv = withSecrets()): KitChannel[] {
  const out: KitChannel[] = [];
  if (env.DEVTO_API_KEY?.trim()) out.push("devto");
  if (env.MASTODON_INSTANCE?.trim() && env.MASTODON_TOKEN?.trim()) out.push("mastodon");
  return out;
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

export function draftKit(db: Database.Database, input: Record<string, unknown>, now = new Date(), env?: NodeJS.ProcessEnv): Kit | string {
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
  const channel = kitChannel(platform, env) ?? undefined;
  const finalBody = link ? body.split(String(input.link)).join(link) : body;
  if (channel === "mastodon" && finalBody.length > MASTODON_MAX) return `Mastodon posts are ${MASTODON_MAX} characters at most (this one is ${finalBody.length}): shorten it.`;
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).slice(0, 4) : undefined;
  const kit: Kit = {
    id, status: "pending", createdAt: now.toISOString(), platform, where, audience, title,
    body: finalBody, link: link ?? "", image: input.image ? text(input.image, 200) : undefined, rules, value,
    channel, tags: tags?.length ? tags : undefined,
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
    kit.channel
      ? `Rien à coller : réponds /publie ${kit.id} et je le publie moi-même sur ${channelLabel(kit.channel)} avec ton compte. Pour passer : /passe ${kit.id} [raison].`
      : `Quand c'est publié : /publie ${kit.id} <lien du post>. Pour passer : /passe ${kit.id} [raison].`,
  ].filter((l) => l !== "").join("\n");
}

export function decideKit(db: Database.Database, id: string, posted: boolean, note: string, now = new Date()): string {
  const kits = listKits(db);
  const kit = kits.find((k) => k.id === id.trim().toLowerCase());
  if (!kit) return `Kit ${id} introuvable (/kits pour la liste).`;
  if (kit.status !== "pending") return `Kit ${id} déjà traité (${kit.status}).`;
  kit.decidedAt = now.toISOString();
  if (posted && kit.channel && !/^https?:\/\//.test(note.trim())) {
    // The owner approves; the runtime posts within a minute with the owner's token.
    kit.status = "approved";
    save(db, kits);
    return `Kit ${id} approuvé : je le publie sur ${channelLabel(kit.channel)} dans la minute et je te donne le lien.`;
  }
  kit.status = posted ? "posted" : "skipped";
  if (posted && /^https?:\/\//.test(note.trim())) kit.postedUrl = note.trim().split(/\s+/)[0];
  else if (note.trim()) kit.note = note.trim().slice(0, 300);
  save(db, kits);
  return posted
    ? `Kit ${id} marqué publié${kit.postedUrl ? ` (${kit.postedUrl})` : ""}. Le bot suivra les visites (ref=kit-${id}).`
    : `Kit ${id} passé${kit.note ? ` (${kit.note})` : ""}. Le bot en tiendra compte.`;
}

export function describeKits(db: Database.Database, options: { pendingOnly?: boolean; limit?: number } = {}): string {
  const kits = listKits(db).filter((k) => !options.pendingOnly || k.status === "pending" || k.status === "approved").slice(-(options.limit ?? 10));
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
  return `${count("pending") + count("approved")} waiting for the owner, ${count("posted")} posted${posted.length ? ` (${posted.join("; ")})` : ""}, ${count("skipped")} skipped, ${count("expired")} expired${count("failed") ? `, ${count("failed")} failed` : ""}`;
}

function channelLabel(channel: KitChannel): string {
  return channel === "devto" ? "dev.to" : "Mastodon";
}

type FetchFn = typeof fetch;

async function postJson(fetchFn: FetchFn, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const resp = await fetchFn(url, {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

/** The dev.to body: the kit's text as markdown, the tracked link once, tags from the kit. */
function devtoArticle(kit: Kit): Record<string, unknown> {
  const body = kit.link && !kit.body.includes(kit.link) ? `${kit.body}\n\n${kit.link}` : kit.body;
  const article: Record<string, unknown> = { title: kit.title, body_markdown: body, published: true };
  if (kit.tags?.length) article.tags = kit.tags;
  if (kit.link) article.canonical_url = kit.link.split("?")[0];
  return { article };
}

/**
 * Publishes approved kits through the owner's dev.to or Mastodon account
 * (runtime only, every minute). Posted kits get their URL and the owner a
 * message; a refused call fails the kit and tells the owner once.
 */
export async function publishApprovedKits(
  db: Database.Database,
  options: { env?: NodeJS.ProcessEnv; fetchFn?: FetchFn; now?: Date; wake?: (reason: string) => void } = {},
): Promise<number> {
  const env = options.env ?? withSecrets();
  const kits = listKits(db);
  const due = kits.filter((k) => k.status === "approved" && k.channel);
  if (due.length === 0) return 0;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? new Date();
  let posted = 0;
  for (const kit of due) {
    try {
      let url = "";
      if (kit.channel === "devto") {
        if (!env.DEVTO_API_KEY?.trim()) throw new Error("DEVTO_API_KEY manquante");
        const created = await postJson(fetchFn, "https://dev.to/api/articles", { "api-key": env.DEVTO_API_KEY.trim() }, devtoArticle(kit));
        url = String(created.url ?? "");
      } else {
        const instance = String(env.MASTODON_INSTANCE ?? "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (!instance || !env.MASTODON_TOKEN?.trim()) throw new Error("MASTODON_INSTANCE ou MASTODON_TOKEN manquant");
        const status = kit.link && !kit.body.includes(kit.link) ? `${kit.body}\n${kit.link}`.slice(0, MASTODON_MAX) : kit.body;
        const created = await postJson(fetchFn, `https://${instance}/api/v1/statuses`, {
          authorization: `Bearer ${env.MASTODON_TOKEN.trim()}`, "idempotency-key": `money-lab-${kit.id}`,
        }, { status, visibility: "public", language: /[àâçéèêëîïôûùüÿœ]/i.test(status) ? "fr" : "en" });
        url = String(created.url ?? created.uri ?? "");
      }
      Object.assign(kit, { status: "posted", postedUrl: url || undefined, decidedAt: now.toISOString() });
      posted++;
      queueOwnerNotification(db, `📣 Kit ${kit.id} publié sur ${channelLabel(kit.channel!)}${url ? ` : ${url}` : ""}`);
      options.wake?.(`Kit ${kit.id} publié sur ${channelLabel(kit.channel!)}${url ? ` (${url})` : ""}`);
    } catch (err: any) {
      const error = String(err?.message ?? err).slice(0, 200);
      Object.assign(kit, { status: "failed", note: error, decidedAt: now.toISOString() });
      queueOwnerNotification(db, `⚠️ Kit ${kit.id} non publié sur ${channelLabel(kit.channel!)} : ${error}. Tu peux le coller toi-même (/kit ${kit.id}) ; vérifie la clé dans /etc/money-lab.env.`);
    }
  }
  save(db, kits);
  return posted;
}

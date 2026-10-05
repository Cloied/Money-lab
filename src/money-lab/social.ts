/**
 * Money Lab social posting (Bluesky)
 *
 * The agent drafts posts (text, optional image it rendered); the runtime
 * publishes them with the owner's Bluesky app password, which the agent
 * cannot read. While approval is required (the default), every draft goes
 * to the owner on Telegram and is published only after /publier. At most
 * 3 posts a day, no replies, no direct messages, no follows: the agent
 * shares its work, it does not spam.
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { getKV, queueOwnerNotification, setKV } from "./journal.js";
import { imagesDir } from "./image.js";

type FetchFn = typeof fetch;

export interface SocialPost {
  id: string;
  network: "bluesky";
  text: string;
  image?: string;
  alt?: string;
  status: "pending" | "approved" | "posted" | "rejected" | "failed";
  createdAt: string;
  decidedAt?: string;
  note?: string;
  postedAt?: string;
  url?: string;
  error?: string;
}

const POSTS_KEY = "money_lab.social_posts";
const APPROVAL_KEY = "money_lab.social_approval";
export const MAX_POSTS_PER_DAY = 3;
const MAX_PENDING = 5;
const MAX_GRAPHEMES = 300;
const MAX_IMAGE_BYTES = 950_000;
const BLUESKY = "https://bsky.social/xrpc";

export function blueskyCredentials(env: NodeJS.ProcessEnv = process.env): { handle: string; password: string } | null {
  const handle = env.BLUESKY_HANDLE?.trim().replace(/^@/, "");
  const password = env.BLUESKY_APP_PASSWORD?.trim();
  return handle && password ? { handle, password } : null;
}

export function listPosts(db: Database.Database): SocialPost[] {
  try {
    const posts = JSON.parse(getKV(db, POSTS_KEY) ?? "[]");
    return Array.isArray(posts) ? (posts as SocialPost[]) : [];
  } catch {
    return [];
  }
}

function save(db: Database.Database, posts: SocialPost[]): void {
  setKV(db, POSTS_KEY, JSON.stringify(posts.slice(-100)));
}

export function approvalRequired(db: Database.Database): boolean {
  return getKV(db, APPROVAL_KEY) !== "auto";
}

export function setApprovalMode(db: Database.Database, mode: "auto" | "required"): void {
  setKV(db, APPROVAL_KEY, mode);
}

function graphemes(text: string): number {
  return [...new Intl.Segmenter("fr", { granularity: "grapheme" }).segment(text)].length;
}

export function draftPost(
  db: Database.Database,
  input: Record<string, unknown>,
  options: { home: string; now?: Date },
): SocialPost | string {
  const now = options.now ?? new Date();
  const text = String(input.text ?? "").trim();
  if (!text) return "text is required.";
  if (graphemes(text) > MAX_GRAPHEMES) return `Bluesky posts are limited to ${MAX_GRAPHEMES} characters (this one has ${graphemes(text)}).`;
  let image: string | undefined;
  let alt: string | undefined;
  if (input.image) {
    image = path.resolve(options.home, String(input.image).replace(/^~(?=$|\/)/, options.home));
    if (!image.startsWith(imagesDir(options.home) + path.sep) || !/\.(png|jpe?g)$/i.test(image) || !fs.existsSync(image)) {
      return "image must be a PNG or JPEG you rendered in ~/images (render_image).";
    }
    if (fs.statSync(image).size > MAX_IMAGE_BYTES) return "image is larger than 950 KB: render it smaller or simpler.";
    alt = String(input.alt ?? "").trim();
    if (alt.length < 10) return "alt is required with an image: describe it for people who cannot see it.";
  }
  const posts = listPosts(db);
  const day = now.toISOString().slice(0, 10);
  const today = posts.filter((p) => p.createdAt.startsWith(day) && p.status !== "rejected" && p.status !== "failed").length;
  if (today >= MAX_POSTS_PER_DAY) return `At most ${MAX_POSTS_PER_DAY} posts a day: keep this one for tomorrow.`;
  if (posts.filter((p) => p.status === "pending").length >= MAX_PENDING) return "Too many drafts wait for the owner: wait for decisions first.";
  if (posts.some((p) => p.text === text && p.status !== "rejected" && p.status !== "failed")) return "This exact text was already drafted or posted.";
  const post: SocialPost = {
    id: `p-${now.getTime().toString(36).slice(-6)}`,
    network: "bluesky",
    text,
    ...(image ? { image, alt } : {}),
    status: approvalRequired(db) ? "pending" : "approved",
    createdAt: now.toISOString(),
  };
  save(db, [...posts, post]);
  if (post.status === "pending") {
    queueOwnerNotification(db,
      `📣 Publication Bluesky proposée (${post.id}) :\n\n${text}\n\n` +
      `${image ? `Image : ${path.basename(image)} (${alt})\n` : ""}` +
      `/publier ${post.id} pour publier, /rejeter ${post.id} [raison] pour refuser.`);
  }
  return post;
}

export function decidePost(db: Database.Database, id: string, approve: boolean, note: string, now = new Date()): string {
  const posts = listPosts(db);
  const post = posts.find((p) => p.id === id);
  if (!post) return `Publication ${id} introuvable.`;
  if (post.status !== "pending") return `Publication ${id} déjà traitée (${post.status}).`;
  post.status = approve ? "approved" : "rejected";
  post.decidedAt = now.toISOString();
  if (note) post.note = note;
  save(db, posts);
  return approve ? `Publication ${id} validée : elle part dans la minute.` : `Publication ${id} refusée${note ? ` (${note})` : ""}.`;
}

/** Link facets: Bluesky needs the byte range of each URL to make it clickable. */
export function linkFacets(text: string): Array<Record<string, unknown>> {
  const facets: Array<Record<string, unknown>> = [];
  const encoder = new TextEncoder();
  for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+[^\s)>\].,;:!?'"]/g)) {
    const byteStart = encoder.encode(text.slice(0, match.index)).length;
    facets.push({
      index: { byteStart, byteEnd: byteStart + encoder.encode(match[0]).length },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: match[0] }],
    });
  }
  return facets;
}

async function xrpc(fetchFn: FetchFn, method: string, init: RequestInit): Promise<any> {
  const resp = await fetchFn(`${BLUESKY}/${method}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${method}: HTTP ${resp.status} ${(data as any).message ?? (data as any).error ?? ""}`.trim());
  return data;
}

/** Publishes approved posts; returns how many were posted. */
export async function publishApproved(
  db: Database.Database,
  options: { env?: NodeJS.ProcessEnv; fetchFn?: FetchFn; now?: () => Date } = {},
): Promise<number> {
  const creds = blueskyCredentials(options.env);
  const due = listPosts(db).filter((p) => p.status === "approved");
  if (!creds || due.length === 0) return 0;
  const fetchFn = options.fetchFn ?? fetch;
  const json = { "content-type": "application/json" };
  const session = await xrpc(fetchFn, "com.atproto.server.createSession", {
    method: "POST", headers: json, body: JSON.stringify({ identifier: creds.handle, password: creds.password }),
  });
  const auth = { authorization: `Bearer ${session.accessJwt}` };
  let posted = 0;
  for (const post of due) {
    const now = options.now?.() ?? new Date();
    const posts = listPosts(db);
    const stored = posts.find((p) => p.id === post.id)!;
    try {
      const record: Record<string, unknown> = {
        $type: "app.bsky.feed.post",
        text: post.text,
        createdAt: now.toISOString(),
        langs: ["fr"],
      };
      const facets = linkFacets(post.text);
      if (facets.length) record.facets = facets;
      if (post.image) {
        const bytes = fs.readFileSync(post.image);
        const mime = /\.png$/i.test(post.image) ? "image/png" : "image/jpeg";
        const upload = await xrpc(fetchFn, "com.atproto.repo.uploadBlob", {
          method: "POST", headers: { ...auth, "content-type": mime }, body: bytes,
        });
        record.embed = { $type: "app.bsky.embed.images", images: [{ alt: post.alt ?? "", image: upload.blob }] };
      }
      const created = await xrpc(fetchFn, "com.atproto.repo.createRecord", {
        method: "POST", headers: { ...auth, ...json },
        body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
      });
      const rkey = String(created.uri ?? "").split("/").pop();
      Object.assign(stored, { status: "posted", postedAt: now.toISOString(), url: `https://bsky.app/profile/${creds.handle}/post/${rkey}` });
      posted++;
      queueOwnerNotification(db, `📣 Publié sur Bluesky : ${stored.url}`);
    } catch (err: any) {
      Object.assign(stored, { status: "failed", error: String(err?.message ?? err).slice(0, 300) });
      queueOwnerNotification(db, `⚠️ Publication ${post.id} échouée : ${stored.error}`);
    }
    save(db, posts);
  }
  return posted;
}

export function describePosts(db: Database.Database, limit = 8): string {
  const posts = listPosts(db).slice(-limit);
  if (posts.length === 0) return "No posts yet.";
  return posts.map((p) =>
    `${p.id} [${p.status}] ${p.createdAt.slice(0, 10)}: ${p.text.slice(0, 80)}${p.text.length > 80 ? "…" : ""}` +
    `${p.url ? ` ${p.url}` : ""}${p.note ? ` (owner: ${p.note})` : ""}${p.error ? ` (error: ${p.error})` : ""}`).join("\n");
}

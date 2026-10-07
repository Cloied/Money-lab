/**
 * Money Lab semantic recall
 *
 * Owner plan (2026-10-07), step 5a: recall matched words; it now also
 * matches meaning when a free embedding model is configured (Gemini,
 * Mistral, Cloudflare or a local Ollama model). Passages of the agent's
 * notes, library, datasets, ideas and experiments are embedded once and
 * cached in the state database; a search embeds the query, scores every
 * cached passage by cosine similarity and blends it with the lexical
 * score. Without a provider, recall stays lexical. Nothing is sent that
 * is not already in the agent's own files (keys are masked anyway).
 */

import crypto from "crypto";
import type Database from "better-sqlite3";
import { type RecallHit, recall, recallChunks } from "./recall.js";
import { freeEmbeddings } from "./freeai.js";

/** New passages embedded per search: keeps a search under a few requests. */
const MAX_NEW_PER_SEARCH = 160;
const MAX_ROWS = 20_000;
const LEXICAL_POOL = 40;

function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS money_lab_embeddings (
      hash TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      source TEXT NOT NULL,
      line INTEGER NOT NULL,
      text TEXT NOT NULL,
      vec BLOB NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS money_lab_embeddings_model ON money_lab_embeddings (model);
  `);
}

function hashOf(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

function fromBlob(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The model that embedded the cache, so a search keeps using it while it is available. */
function cachedModel(db: Database.Database): string | null {
  const row = db.prepare("SELECT model FROM money_lab_embeddings GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1").get() as { model: string } | undefined;
  return row?.model ?? null;
}

export interface SemanticRecallOptions {
  home: string;
  db: Database.Database;
  limit?: number;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export interface SemanticRecallResult {
  hits: RecallHit[];
  mode: "lexical" | "semantic";
  provider?: string;
  embedded: number;
  cached: number;
}

/**
 * Lexical hits blended with meaning: the query and the not-yet-embedded
 * passages are embedded (bounded per search), every cached passage is
 * scored by cosine similarity, and the final score is the normalized
 * lexical score plus the similarity. Falls back to lexical results when
 * no free embedding provider answers.
 */
export async function semanticRecall(query: string, options: SemanticRecallOptions): Promise<SemanticRecallResult> {
  const limit = options.limit ?? 8;
  const lexical = recall(query, { home: options.home, db: options.db, limit: LEXICAL_POOL });
  if (!query.trim()) return { hits: [], mode: "lexical", embedded: 0, cached: 0 };
  ensureTable(options.db);
  const db = options.db;
  const now = options.now ?? (() => new Date());

  // Passages to embed: everything recall can see, newest first, minus what is cached.
  const chunks = recallChunks(options.home, db).map((c) => ({ ...c, hash: hashOf(c.text) }));
  const known = new Set((db.prepare("SELECT hash FROM money_lab_embeddings").all() as { hash: string }[]).map((r) => r.hash));
  const fresh = chunks.filter((c) => !known.has(c.hash));
  const batch = fresh.slice(0, MAX_NEW_PER_SEARCH);
  const preferred = cachedModel(db) ?? undefined;
  const result = await freeEmbeddings([query, ...batch.map((c) => c.text)], { db, env: options.env, fetchFn: options.fetchFn, now, preferred });
  if (!result) return { hits: lexical.slice(0, limit), mode: "lexical", embedded: 0, cached: known.size };
  const model = `${result.provider} ${result.model}`;
  const [queryVec, ...vectors] = result.vectors;

  // A different model than the cache: start the cache over for that model.
  if (preferred && preferred !== model) db.prepare("DELETE FROM money_lab_embeddings WHERE model != ?").run(model);
  const insert = db.prepare("INSERT OR REPLACE INTO money_lab_embeddings (hash, model, source, line, text, vec, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const tx = db.transaction(() => {
    batch.forEach((c, i) => insert.run(c.hash, model, c.source, c.line, c.text, toBlob(vectors[i]), now().toISOString()));
    const count = (db.prepare("SELECT COUNT(*) AS n FROM money_lab_embeddings").get() as { n: number }).n;
    if (count > MAX_ROWS) db.prepare("DELETE FROM money_lab_embeddings WHERE hash IN (SELECT hash FROM money_lab_embeddings ORDER BY at ASC LIMIT ?)").run(count - MAX_ROWS);
  });
  tx();

  // Score every cached passage of this model against the query.
  const rows = db.prepare("SELECT hash, source, line, text, vec FROM money_lab_embeddings WHERE model = ?").all(model) as Array<{ hash: string; source: string; line: number; text: string; vec: Buffer }>;
  const maxLexical = Math.max(1, ...lexical.map((h) => h.score));
  const lexicalByKey = new Map(lexical.map((h) => [`${h.source}:${h.line}`, h.score / maxLexical]));
  const scored: RecallHit[] = rows.map((r) => {
    const sim = cosine(queryVec, fromBlob(r.vec));
    const lex = lexicalByKey.get(`${r.source}:${r.line}`) ?? 0;
    return { source: r.source, line: r.line, text: r.text, score: Math.round((sim + lex) * 1000) / 1000 };
  }).filter((h) => h.score > 0.25);
  // Lexical hits whose passage is not embedded yet still count.
  for (const h of lexical) {
    if (!scored.some((s) => s.source === h.source && s.line === h.line)) scored.push({ ...h, score: Math.round((h.score / maxLexical) * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked: RecallHit[] = [];
  for (const hit of scored) {
    if (picked.some((p) => p.source === hit.source && Math.abs(p.line - hit.line) < 12)) continue;
    picked.push(hit);
    if (picked.length >= limit) break;
  }
  return { hits: picked, mode: "semantic", provider: model, embedded: batch.length, cached: rows.length };
}

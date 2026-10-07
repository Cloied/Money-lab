/**
 * Money Lab niche funnel
 *
 * Owner plan (2026-10-07), step 3: the agent studied a handful of ideas
 * found by chance. The funnel makes discovery wide and cheap:
 * - a seed universe (categories of needs, French and English) the agent
 *   expands into concrete search intents with the free models;
 * - niche_scan: for each intent, countable signals from free public
 *   sources (Google suggestions by intent, Wikipedia audience, Hacker News
 *   discussion, open-source alternatives on GitHub) and a fixed formula
 *   score, so the ranking is the data's, not the agent's opinion;
 * - a memory: every scanned niche keeps its score and signals; a rejected
 *   niche keeps its reason and is never scanned again.
 * No inference: a scan costs nothing but a few public requests.
 */

import type Database from "better-sqlite3";
import { getKV, setKV } from "./journal.js";
import { saveRecord } from "./datasets.js";

type FetchFn = typeof fetch;

const STATE_KEY = "money_lab.niches";
const USER_AGENT = "MoneyLabBot/1.0 (market research; https://github.com/Cloied/Money-lab)";
const TIMEOUT_MS = 15_000;
/** Niches per call: each one costs about six public requests. */
export const MAX_NICHES_PER_SCAN = 25;
/** A scan older than this is redone. */
const RESCAN_MS = 7 * 86_400_000;
/** Spacing between Google suggestion requests (one server, be polite). */
const SUGGEST_SPACING_MS = 250;
const MAX_STORED = 600;

export type Lang = "fr" | "en";

export interface NicheSignals {
  suggestions: number;
  commercial: number;
  wikipediaViews: number | null;
  hackerNews: number | null;
  githubRepos: number | null;
  examples: string[];
}

export interface NicheScore {
  demand: number;
  intent: number;
  audience: number;
  discussion: number;
  competition: number;
  total: number;
}

export interface ScannedNiche {
  niche: string;
  lang: Lang;
  at: string;
  signals: NicheSignals;
  score: NicheScore;
  errors: string[];
}

interface FunnelState {
  scanned: Record<string, ScannedNiche>;
  rejected: Record<string, { reason: string; at: string }>;
}

/**
 * Seed universe: categories of needs with starting phrases. The agent
 * expands each seed into 5-10 concrete search intents (harvest, free), then
 * scans them. Covers professions, procedures, life moments, hobbies,
 * obligations, data and repetitive tasks.
 */
export const NICHE_SEEDS: Record<string, { fr: string[]; en: string[] }> = {
  "artisans et indépendants": {
    fr: ["devis plombier", "facture auto-entrepreneur", "calcul TVA artisan", "planning chantier", "attestation TVA 10 %", "tarif horaire électricien", "note de frais indépendant", "relance facture impayée"],
    en: ["plumber quote template", "freelance invoice generator", "contractor estimate calculator", "job scheduling small business", "late payment reminder letter", "hourly rate calculator freelancer"],
  },
  "démarches administratives": {
    fr: ["lettre de résiliation", "attestation d'hébergement", "procuration modèle", "déclaration de sinistre", "demande de congé parental", "lettre de contestation amende", "changement d'adresse liste", "modèle de bail meublé"],
    en: ["cancellation letter template", "proof of residence letter", "power of attorney template", "insurance claim letter", "change of address checklist", "parking ticket appeal letter"],
  },
  "immobilier et logement": {
    fr: ["calcul frais de notaire", "simulateur capacité d'emprunt", "état des lieux modèle", "calcul loyer plafonné", "répartition charges colocation", "calcul surface habitable", "préavis logement"],
    en: ["mortgage affordability calculator", "rent split calculator roommates", "move-in inspection checklist", "closing costs calculator", "security deposit letter", "rent increase calculator"],
  },
  "emploi et salaires": {
    fr: ["calcul salaire brut net", "simulateur indemnité de licenciement", "calcul congés payés", "lettre de démission", "calcul heures supplémentaires", "simulateur prime d'activité", "calcul ancienneté"],
    en: ["salary after tax calculator", "severance pay calculator", "overtime calculator", "resignation letter template", "PTO accrual calculator", "hourly to salary calculator"],
  },
  "famille et moments de vie": {
    fr: ["calcul pension alimentaire", "liste naissance", "budget mariage calcul", "calcul âge de départ retraite", "faire-part modèle", "calcul garde alternée", "checklist déménagement"],
    en: ["child support calculator", "wedding budget calculator", "baby due date calculator", "moving checklist printable", "retirement age calculator", "custody schedule calculator"],
  },
  "argent et impôts": {
    fr: ["simulateur impôt revenu", "calcul intérêts composés", "calcul plus-value immobilière", "simulateur livret A", "calcul TVA", "calcul frais kilométriques", "échéancier prêt"],
    en: ["compound interest calculator", "capital gains tax calculator", "mileage reimbursement calculator", "loan amortization schedule", "sales tax calculator", "tip split calculator"],
  },
  "santé et quotidien": {
    fr: ["calcul IMC", "calcul date d'ovulation", "convertisseur calories", "calcul besoins en eau", "planning repas semaine", "calcul dose paracétamol enfant", "calcul sommeil cycles"],
    en: ["BMI calculator metric", "ovulation calculator", "meal plan template weekly", "sleep cycle calculator", "water intake calculator", "calorie deficit calculator"],
  },
  "études et apprentissage": {
    fr: ["calcul moyenne bac", "convertisseur notes", "planning révisions", "générateur de fiches", "calcul ECTS", "lettre de motivation stage", "calcul mention"],
    en: ["GPA calculator", "grade calculator weighted", "study schedule generator", "flashcard maker", "citation generator APA", "word count tool"],
  },
  "loisirs et hobbies": {
    fr: ["calcul rendement potager", "convertisseur mesures cuisine", "planning entraînement course", "calcul allure course", "calcul pelote laine tricot", "calcul dilution e-liquide", "calcul dose engrais"],
    en: ["pace calculator running", "recipe converter servings", "knitting yarn calculator", "garden planting calendar", "brewing calculator ABV", "aquarium volume calculator"],
  },
  "voitures et transport": {
    fr: ["calcul consommation carburant", "calcul coût trajet", "simulateur malus écologique", "calcul prix carte grise", "comparateur coût voiture", "calcul temps de trajet", "contrôle technique checklist"],
    en: ["fuel cost calculator trip", "car payment calculator", "tire size calculator", "road trip cost splitter", "electric car charging cost calculator", "car depreciation calculator"],
  },
  "obligations légales des entreprises": {
    fr: ["facture électronique obligatoire 2026", "mentions obligatoires facture", "registre des traitements RGPD modèle", "affichage obligatoire entreprise", "calcul délai de paiement", "modèle CGV", "document unique modèle"],
    en: ["GDPR records of processing template", "invoice legal requirements", "privacy policy generator small business", "terms of service template", "e-invoicing compliance checklist", "payment terms calculator"],
  },
  "données difficiles à obtenir": {
    fr: ["prix moyen m2 ville", "jours fériés 2027", "calendrier scolaire 2027", "horaires marée", "indice loyers IRL", "taux usure", "salaire médian métier"],
    en: ["public holidays 2027", "school calendar 2027", "tide times", "average rent by city", "sunrise sunset times", "minimum wage by state 2027"],
  },
  "tâches répétitives web et bureau": {
    fr: ["convertisseur PDF JPG", "fusionner PDF en ligne", "compresser image", "générateur QR code", "signature mail générateur", "convertisseur CSV Excel", "compteur de mots"],
    en: ["merge PDF online free", "compress image without losing quality", "QR code generator free", "email signature generator", "CSV to Excel converter", "image to text OCR free"],
  },
  "associations et collectivités": {
    fr: ["reçu fiscal don modèle", "appel à cotisation modèle", "planning bénévoles", "budget association modèle", "compte rendu AG modèle", "convocation assemblée générale"],
    en: ["donation receipt template", "volunteer schedule template", "nonprofit budget template", "meeting minutes template", "membership fee reminder"],
  },
  "développeurs et data": {
    fr: ["générateur cron", "convertisseur JSON CSV", "regex testeur", "générateur mot de passe", "calcul sous-réseau IP", "formateur SQL", "convertisseur timestamp"],
    en: ["cron expression generator", "JSON to CSV converter", "regex tester", "subnet calculator", "SQL formatter", "unix timestamp converter", "JWT decoder"],
  },
};

function loadState(db: Database.Database): FunnelState {
  try {
    const raw = JSON.parse(getKV(db, STATE_KEY) ?? "{}");
    return { scanned: raw.scanned ?? {}, rejected: raw.rejected ?? {} };
  } catch {
    return { scanned: {}, rejected: {} };
  }
}

function saveState(db: Database.Database, state: FunnelState): void {
  const entries = Object.entries(state.scanned);
  if (entries.length > MAX_STORED) {
    // Keep the best and the newest; drop the oldest low scores.
    entries.sort((a, b) => b[1].score.total - a[1].score.total || b[1].at.localeCompare(a[1].at));
    state.scanned = Object.fromEntries(entries.slice(0, MAX_STORED));
  }
  setKV(db, STATE_KEY, JSON.stringify(state));
}

export function nicheKey(niche: string): string {
  return niche.trim().toLowerCase().replace(/\s+/g, " ");
}

async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string> = {}): Promise<any> {
  const resp = await fetchFn(url, { headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  return resp.json();
}

const COMMERCIAL = {
  fr: /prix|tarif|gratuit|pas cher|acheter|devis|coût|cout|abonnement|payant|comparatif|meilleur/i,
  en: /price|cost|free|cheap|buy|quote|pricing|subscription|paid|best|comparison|review/i,
};

/** Search intents that turn a subject into a tool people look for. */
function variants(niche: string, lang: Lang): string[] {
  return lang === "fr"
    ? [niche, `${niche} gratuit`, `${niche} en ligne`, `calculateur ${niche}`, `modèle ${niche}`, `simulateur ${niche}`]
    : [niche, `free ${niche}`, `${niche} online`, `${niche} calculator`, `${niche} template`, `${niche} generator`];
}

async function suggestions(niche: string, lang: Lang, fetchFn: FetchFn, sleep: (ms: number) => Promise<void>): Promise<{ all: string[]; commercial: number }> {
  const all = new Set<string>();
  for (const [i, v] of variants(niche, lang).entries()) {
    if (i > 0) await sleep(SUGGEST_SPACING_MS);
    const data = await getJson(fetchFn, `https://suggestqueries.google.com/complete/search?client=firefox&ie=UTF-8&oe=UTF-8&hl=${lang}&q=${encodeURIComponent(v)}`);
    for (const s of Array.isArray(data?.[1]) ? data[1] : []) all.add(String(s).toLowerCase());
  }
  const list = [...all].filter((s) => s !== niche.toLowerCase());
  return { all: list, commercial: list.filter((s) => COMMERCIAL[lang].test(s)).length };
}

async function wikipediaViews(niche: string, lang: Lang, fetchFn: FetchFn, now: Date): Promise<number | null> {
  const search = await getJson(fetchFn, `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(niche)}&limit=1&namespace=0&format=json`);
  const title: string | undefined = Array.isArray(search?.[1]) ? search[1][0] : undefined;
  if (!title) return null;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), 1));
  const stamp = (d: Date) => `${d.toISOString().slice(0, 10).replace(/-/g, "")}00`;
  const data = await getJson(fetchFn, `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/monthly/${stamp(start)}/${stamp(end)}`);
  const views = ((data?.items ?? []) as any[]).map((i) => Number(i.views) || 0);
  return views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null;
}

async function hackerNewsCount(niche: string, fetchFn: FetchFn, now: Date): Promise<number> {
  const yearAgo = Math.floor(now.getTime() / 1000) - 365 * 86_400;
  const data = await getJson(fetchFn, `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(niche)}&tags=(story,ask_hn,show_hn)&numericFilters=created_at_i>${yearAgo}&hitsPerPage=0`);
  return Number(data?.nbHits ?? 0);
}

async function githubCount(niche: string, fetchFn: FetchFn, token?: string): Promise<number> {
  const data = await getJson(fetchFn, `https://api.github.com/search/repositories?q=${encodeURIComponent(niche)}&per_page=1`,
    { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) });
  return Number(data?.total_count ?? 0);
}

/**
 * The formula, fixed and documented so the agent can check it:
 * demand (0-10) = distinct suggestions / 4; intent (0-10) = commercial suggestions x 2;
 * audience (0-10) = 3 x log10(Wikipedia monthly views / 100); discussion (0-10) = HN stories in 12 months / 5;
 * competition (0-7) from open-source alternatives (0, <10: 1, <100: 3, <1000: 5, else 7).
 * total /100 = (3 demand + 2 intent + 2 audience + discussion - 2 competition) / 80.
 */
export function scoreNiche(s: NicheSignals): NicheScore {
  const cap = (n: number) => Math.max(0, Math.min(10, Math.round(n)));
  const demand = cap(s.suggestions / 4);
  const intent = cap(s.commercial * 2);
  const audience = s.wikipediaViews && s.wikipediaViews > 100 ? cap(3 * Math.log10(s.wikipediaViews / 100)) : 0;
  const discussion = s.hackerNews === null ? 0 : cap(s.hackerNews / 5);
  const repos = s.githubRepos ?? 0;
  const competition = repos === 0 ? 0 : repos < 10 ? 1 : repos < 100 ? 3 : repos < 1000 ? 5 : 7;
  const raw = 3 * demand + 2 * intent + 2 * audience + discussion - 2 * competition;
  return { demand, intent, audience, discussion, competition, total: Math.max(0, Math.round((raw / 80) * 100)) };
}

export interface ScanOptions {
  home: string;
  fetchFn?: FetchFn;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  githubToken?: string;
  fresh?: boolean;
}

/** Scans up to MAX_NICHES_PER_SCAN niches; skips rejected ones and recent scans. */
export async function scanNiches(db: Database.Database, niches: string[], lang: Lang, options: ScanOptions): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? new Date();
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const state = loadState(db);
  const wanted = [...new Set(niches.map(nicheKey).filter((n) => n.length >= 3))];
  if (wanted.length === 0) return "niches is required: a list of short search phrases (3 to 6 words each).";
  const batch = wanted.slice(0, MAX_NICHES_PER_SCAN);
  const lines: string[] = [];
  let stop: string | null = null;
  for (const niche of batch) {
    if (state.rejected[niche]) {
      lines.push(`- ${niche}: rejected earlier (${state.rejected[niche].reason}); not scanned`);
      continue;
    }
    const previous = state.scanned[niche];
    if (previous && !options.fresh && now.getTime() - Date.parse(previous.at) < RESCAN_MS) {
      lines.push(formatNiche(previous, "cached"));
      continue;
    }
    if (stop) {
      lines.push(`- ${niche}: not scanned (${stop})`);
      continue;
    }
    const errors: string[] = [];
    const signals: NicheSignals = { suggestions: 0, commercial: 0, wikipediaViews: null, hackerNews: null, githubRepos: null, examples: [] };
    try {
      const sug = await suggestions(niche, lang, fetchFn, sleep);
      signals.suggestions = sug.all.length;
      signals.commercial = sug.commercial;
      signals.examples = sug.all.slice(0, 6);
    } catch (err: any) {
      errors.push(`google_suggest: ${err?.message ?? err}`);
      if (err?.status === 429 || err?.status === 403) stop = "Google is limiting this server; try again in an hour";
    }
    const [wiki, hn, gh] = await Promise.all([
      wikipediaViews(niche, lang, fetchFn, now).catch((e) => { errors.push(`wikipedia: ${e?.message ?? e}`); return null; }),
      hackerNewsCount(niche, fetchFn, now).catch((e) => { errors.push(`hackernews: ${e?.message ?? e}`); return null; }),
      githubCount(niche, fetchFn, options.githubToken).catch((e) => { errors.push(`github: ${e?.message ?? e}`); return null; }),
    ]);
    signals.wikipediaViews = wiki;
    signals.hackerNews = hn;
    signals.githubRepos = gh;
    const scanned: ScannedNiche = { niche, lang, at: now.toISOString(), signals, score: scoreNiche(signals), errors };
    state.scanned[niche] = scanned;
    lines.push(formatNiche(scanned));
    saveRecord(options.home, "niches", { source: "niche_scan", ref: niche, data: scanned }, now);
  }
  saveState(db, state);
  const skipped = wanted.length - batch.length;
  return [
    `Niche scan (${lang}, ${now.toISOString().slice(0, 10)}; formula: 3 demand + 2 intent + 2 audience + discussion - 2 competition, /80):`,
    ...lines,
    skipped > 0 ? `${skipped} more not scanned this call (at most ${MAX_NICHES_PER_SCAN} per call): call again with the rest.` : "",
    "Next: niche_scan list to see the ranking; reject the weak ones with a reason; study the top ones with market_signals and harvest; record the best as ideas.",
  ].filter(Boolean).join("\n");
}

function formatNiche(n: ScannedNiche, note = ""): string {
  const s = n.signals;
  const sc = n.score;
  return `- ${n.niche}: ${sc.total}/100${note ? ` (${note} ${n.at.slice(0, 10)})` : ""} — demand ${sc.demand} (${s.suggestions} suggestions), ` +
    `intent ${sc.intent} (${s.commercial} commercial), audience ${sc.audience} (${s.wikipediaViews === null ? "no article" : `${s.wikipediaViews.toLocaleString("en-US")} views/month`}), ` +
    `discussion ${sc.discussion} (${s.hackerNews ?? "?"} HN stories), competition -${sc.competition} (${s.githubRepos ?? "?"} repos)` +
    `${s.examples.length ? `\n  people type: ${s.examples.join(" | ")}` : ""}${n.errors.length ? `\n  partial: ${n.errors.join("; ")}` : ""}`;
}

export function rejectNiche(db: Database.Database, niche: string, reason: string, now = new Date()): string {
  const key = nicheKey(niche);
  if (!key) return "niche is required.";
  if (!reason.trim()) return "reason is required: it is what stops you from studying this niche again.";
  const state = loadState(db);
  state.rejected[key] = { reason: reason.trim().slice(0, 300), at: now.toISOString() };
  saveState(db, state);
  return `Niche "${key}" rejected (${reason.trim().slice(0, 100)}). It is skipped by future scans and listings.`;
}

export function listNiches(db: Database.Database, options: { limit?: number; lang?: Lang } = {}): string {
  const state = loadState(db);
  const ranked = Object.values(state.scanned)
    .filter((n) => !state.rejected[n.niche] && (!options.lang || n.lang === options.lang))
    .sort((a, b) => b.score.total - a.score.total);
  const rejected = Object.keys(state.rejected).length;
  if (ranked.length === 0) return `No niche scanned yet${rejected ? ` (${rejected} rejected)` : ""}. Start with niche_scan seeds, expand a category with harvest, then scan.`;
  const top = ranked.slice(0, Math.min(50, Math.max(1, options.limit ?? 30)));
  return [
    `${ranked.length} niche(s) scanned${rejected ? `, ${rejected} rejected` : ""}; top ${top.length} by score:`,
    ...top.map((n) => formatNiche(n)),
  ].join("\n");
}

export function describeSeeds(category?: string, lang?: Lang): string {
  const cats = Object.keys(NICHE_SEEDS);
  if (!category) {
    return `Seed categories (${cats.length}): ${cats.join("; ")}.\nCall niche_scan seeds with a category to get its starting phrases, expand each into 5-10 concrete search intents ` +
      "with harvest (what people would type, in the language of the market), then scan them.";
  }
  const key = cats.find((c) => c.toLowerCase().includes(category.toLowerCase()));
  if (!key) return `Unknown category "${category}". Categories: ${cats.join("; ")}.`;
  const seeds = NICHE_SEEDS[key];
  const langs: Lang[] = lang ? [lang] : ["fr", "en"];
  return [`Seeds for "${key}":`, ...langs.map((l) => `${l}: ${seeds[l].join(" | ")}`)].join("\n");
}

/** One line for the prompt. */
export function describeFunnel(db: Database.Database): string {
  const state = loadState(db);
  const scanned = Object.values(state.scanned).filter((n) => !state.rejected[n.niche]);
  if (scanned.length === 0) return "no niche scanned yet (niche_scan seeds to start)";
  const top = scanned.sort((a, b) => b.score.total - a.score.total).slice(0, 3).map((n) => `${n.niche} ${n.score.total}`);
  return `${scanned.length} scanned, ${Object.keys(state.rejected).length} rejected; top: ${top.join(", ")}`;
}

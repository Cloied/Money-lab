/**
 * Telegram channel between the owner and the bot.
 *
 * Only the configured owner chat is served; every other chat is ignored.
 * Commands map to the local operator actions (same code as the CLI); any
 * other text is delivered to the agent as an inbox message and wakes it.
 * Outgoing messages come from the outbox (queueOwnerNotification), so the
 * agent loop never calls Telegram directly. The bot token is read from an
 * environment variable and never logged or shown to the agent.
 */

import type Database from "better-sqlite3";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";
import { runMoneyLabCommand } from "./cli.js";
import { formatStatus } from "./status.js";
import {
  getKV,
  markOwnerNotificationSent,
  pendingOwnerNotifications,
  setKV,
  OWNER_TELEGRAM_SENDER,
} from "./journal.js";

const KV_OFFSET = "money_lab.telegram_offset";
const KV_SUMMARY_DAY = "money_lab.telegram_summary_day";
const MAX_MESSAGE = 3900;

export const TELEGRAM_HELP = `Commandes Money Lab :
/statut — état complet (budget, expériences, demandes, finances)
/resume — résumé du jour
/pause [raison] — mettre le bot en pause
/reprendre — relancer le bot
/aides — demandes d'aide ouvertes
/ok <id> [note] — demande faite (le bot vérifiera)
/non <id> [raison] — demande refusée
/fonds <montant $> [réf] — ajouter des fonds (ex : /fonds 21.50)
/revenu <montant $> <réf> — revenu hors Stripe, confirmé par toi
/aide — cette liste
Tout autre message est transmis au bot.`;

type FetchFn = typeof fetch;

interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
}

function splitMessage(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MESSAGE) parts.push(text.slice(i, i + MAX_MESSAGE));
  return parts.length ? parts : [""];
}

/** Dollars as typed by the owner ("21.50", "21,50") to integer cents. */
export function parseDollars(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export class TelegramChannel {
  constructor(
    private readonly token: string,
    private readonly ownerChatId: number,
    private readonly db: AutomatonDatabase,
    private readonly config: AutomatonConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private get raw(): Database.Database {
    return this.db.raw;
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<any> {
    const resp = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await resp.json().catch(() => ({}))) as any;
    if (!resp.ok || data.ok === false) {
      // Never include the URL (it contains the token) in the error.
      throw new Error(`Telegram ${method} failed: ${resp.status} ${data.description ?? ""}`.trim());
    }
    return data.result;
  }

  async send(text: string): Promise<void> {
    for (const part of splitMessage(text)) {
      await this.call("sendMessage", { chat_id: this.ownerChatId, text: part });
    }
  }

  /** Handle one owner message; returns the reply text (or null for forwarded text). */
  handleOwnerText(text: string, updateId: number): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      const at = new Date().toISOString();
      this.db.insertInboxMessage({
        id: `tg_${updateId}`,
        from: OWNER_TELEGRAM_SENDER,
        to: "",
        content: trimmed,
        signedAt: at,
        createdAt: at,
      });
      this.raw.prepare(
        "INSERT INTO wake_events (source, reason, payload) VALUES ('money_lab_operator', 'Message du propriétaire', '{}')",
      ).run();
      return null;
    }

    const [rawCommand, ...args] = trimmed.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@.*$/, "");
    const out: string[] = [];
    const run = (argv: string[]) => {
      runMoneyLabCommand(argv, this.raw, this.config, (t) => out.push(t));
      return out.join("\n");
    };

    switch (command) {
      case "/start":
      case "/aide":
      case "/help":
        return TELEGRAM_HELP;
      case "/statut":
      case "/status":
        return formatStatus(this.raw, this.config);
      case "/resume":
        return run(["summary"]);
      case "/pause":
        return run(["pause", ...args]);
      case "/reprendre":
        return run(["resume"]);
      case "/aides":
        return run(["help-list"]);
      case "/ok":
      case "/non": {
        const [id, ...note] = args;
        if (!id) return `Usage : ${command} <id> [note]`;
        const fallback = command === "/ok" ? "fait par le propriétaire" : "refusé par le propriétaire";
        return run([command === "/ok" ? "help-resolve" : "help-reject", id, ...(note.length ? note : [fallback])]);
      }
      case "/fonds": {
        const cents = parseDollars(args[0]);
        if (cents === null) return "Usage : /fonds <montant en $> [référence] — ex : /fonds 21.50";
        const ref = args[1] ?? `telegram-${updateId}`;
        run(["ledger-add", "owner_funding", String(cents), ref, "dépôt via Telegram"]);
        this.raw.prepare(
          "INSERT INTO wake_events (source, reason, payload) VALUES ('money_lab_operator', 'Fonds ajoutés', '{}')",
        ).run();
        return out.join("\n");
      }
      case "/revenu": {
        const cents = parseDollars(args[0]);
        if (cents === null || !args[1]) return "Usage : /revenu <montant en $> <référence> — ex : /revenu 12.00 vente-42";
        return run(["ledger-add", "confirmed_revenue", String(cents), args[1], "revenu confirmé via Telegram"]);
      }
      default:
        return `Commande inconnue.\n\n${TELEGRAM_HELP}`;
    }
  }

  /** Fetch new updates, serve the owner's messages, then flush the outbox. */
  async tick(now: Date = new Date()): Promise<void> {
    const offset = Number(getKV(this.raw, KV_OFFSET) ?? "0");
    const updates = (await this.call("getUpdates", {
      offset,
      timeout: 0,
      allowed_updates: ["message"],
    })) as TelegramUpdate[];

    for (const update of updates ?? []) {
      setKV(this.raw, KV_OFFSET, String(update.update_id + 1));
      const msg = update.message;
      if (!msg || msg.chat.id !== this.ownerChatId || typeof msg.text !== "string") continue;
      const reply = this.handleOwnerText(msg.text, update.update_id);
      await this.send(reply ?? "Message transmis au bot.");
    }

    // Daily summary once per UTC day, after 07:00 UTC.
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() >= 7 && getKV(this.raw, KV_SUMMARY_DAY) !== day) {
      setKV(this.raw, KV_SUMMARY_DAY, day);
      const out: string[] = [];
      runMoneyLabCommand(["summary"], this.raw, this.config, (t) => out.push(t));
      await this.send(out.join("\n"));
    }

    for (const item of pendingOwnerNotifications(this.raw)) {
      await this.send(item.text);
      markOwnerNotificationSent(this.raw, item.id);
    }
  }
}

/** Build the channel from config and environment; null when not configured. */
export function createTelegramChannel(
  db: AutomatonDatabase,
  config: AutomatonConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchFn = fetch,
): TelegramChannel | null {
  const tg = config.moneyLab?.telegram;
  if (!tg) return null;
  const token = env[tg.botTokenEnv];
  if (!token) return null;
  return new TelegramChannel(token, tg.ownerChatId, db, config, fetchFn);
}

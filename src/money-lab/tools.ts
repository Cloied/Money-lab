/**
 * Money Lab agent tools: record_experiment, request_help, money_lab_status.
 *
 * The agent can create and update experiments and open help requests.
 * It cannot resolve help requests, write the ledger, resume a pause or
 * change limits; those are operator CLI actions.
 */

import type { AutomatonTool } from "../types.js";
import {
  EXPERIMENT_STATUSES,
  upsertExperiment,
  createHelpRequest,
  type ExperimentStatus,
} from "./journal.js";
import { formatStatus } from "./status.js";

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return String(value);
}

function optionalCents(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  return Number(value);
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Expected an array of strings");
  return value.map((v) => String(v));
}

export function createMoneyLabTools(): AutomatonTool[] {
  return [
    {
      name: "record_experiment",
      description:
        "Create or update a Money Lab experiment record. Omit id to create. Evidence is appended (links with dates), " +
        "metrics are merged. Amounts are integer USD cents; use null when unknown. Only one experiment may be 'building'.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing experiment id to update" },
          status: { type: "string", enum: [...EXPERIMENT_STATUSES] },
          hypothesis: { type: "string", description: "User problem and what the test should show" },
          evidence: { type: "array", items: { type: "string" }, description: "Evidence references to append" },
          artifact_ref: { type: "string", description: "Artifact or deployment reference" },
          revenue_model: { type: "string", description: "Chosen revenue hypothesis, or none" },
          acquisition_channel: { type: "string", description: "Permitted acquisition channel" },
          spend_allowance_cents: { type: "integer" },
          consumed_cost_cents: { type: "integer" },
          review_date: { type: "string", description: "Planned review date (ISO 8601)" },
          metrics: { type: "object", description: "Observed metrics, e.g. visits, genuine uses" },
          result: { type: "string" },
        },
        required: ["status"],
      },
      execute: async (args, ctx) => {
        const exp = upsertExperiment(ctx.db.raw, {
          id: optionalString(args.id) ?? undefined,
          status: String(args.status) as ExperimentStatus,
          hypothesis: optionalString(args.hypothesis) ?? undefined,
          evidence: stringList(args.evidence),
          artifactRef: optionalString(args.artifact_ref),
          revenueModel: optionalString(args.revenue_model),
          acquisitionChannel: optionalString(args.acquisition_channel),
          spendAllowanceCents: optionalCents(args.spend_allowance_cents),
          consumedCostCents: optionalCents(args.consumed_cost_cents),
          reviewDate: optionalString(args.review_date),
          metrics: (args.metrics as Record<string, unknown> | undefined) ?? undefined,
          result: optionalString(args.result),
        });
        return `Experiment ${exp.id} recorded with status ${exp.status}.`;
      },
    },
    {
      name: "request_help",
      description:
        "Ask the owner for a manual action outside your envelope (account, verification, CAPTCHA, purchase approval, " +
        "tool access). Persisted and shown to the operator. Never include secrets. Then sleep; do not poll for a reply.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          experiment_id: { type: "string" },
          reason: { type: "string" },
          human_action: { type: "string", description: "Exact action the owner must perform" },
          link: { type: "string" },
          expected_cost_cents: { type: "integer", description: "Expected cost in USD cents; omit if unknown" },
          permissions_requested: { type: "array", items: { type: "string" } },
          resume_condition: { type: "string", description: "Verifiable condition that must hold before resuming" },
        },
        required: ["reason", "human_action", "resume_condition"],
      },
      execute: async (args, ctx) => {
        const help = createHelpRequest(ctx.db.raw, {
          experimentId: optionalString(args.experiment_id) ?? null,
          reason: String(args.reason ?? ""),
          humanAction: String(args.human_action ?? ""),
          link: optionalString(args.link) ?? null,
          expectedCostCents: optionalCents(args.expected_cost_cents) ?? null,
          permissionsRequested: stringList(args.permissions_requested) ?? [],
          resumeCondition: String(args.resume_condition ?? ""),
        });
        return `Help request ${help.id} recorded for the owner. Sleep or continue unrelated permitted work; ` +
          "you will be woken when the owner resolves it.";
      },
    },
    {
      name: "money_lab_status",
      description: "Show Money Lab experiments, open help requests, budgets and recorded finances.",
      category: "survival",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => formatStatus(ctx.db.raw, ctx.config),
    },
  ];
}

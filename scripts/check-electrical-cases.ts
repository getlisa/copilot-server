/**
 * End-to-end behavioural check of the Estimating Agent on real electrical PROBLEM
 * statements — the shape a technician actually speaks, not a parts list.
 *
 * Runs the REAL SYSTEM_PROMPT and TURN_JSON_SCHEMA (read from the source file, so it can't
 * drift from what ships) through two turns per case:
 *   turn 1 — the problem, with followUpsAsked=2 so the agent skips clarification and proposes
 *   turn 2 — "yes", which is when it emits add_item operations
 *
 * Then scores every produced line against the seeded pricebook. Deliberately does NOT call
 * SerpApi: it reports which lines WOULD go to Home Depot rather than spending 5 searches each
 * from a 411-search free quota.
 *
 *   OPENAI_API_KEY=… npx tsx scripts/check-electrical-cases.ts
 */
import { readFileSync } from "node:fs";
import { matchPricebook } from "../src/copilot/estimating/pricebookMatch";
import { callStructured } from "../src/copilot/estimate/estimateService";

const AGENT_SRC = readFileSync(`${__dirname}/../src/copilot/estimating/estimatingAgent.ts`, "utf8");

/** Pull the live prompt out of the source so this test always reflects what ships. */
function extractPrompt(): string {
  const start = AGENT_SRC.indexOf("const SYSTEM_PROMPT = `") + "const SYSTEM_PROMPT = `".length;
  const end = AGENT_SRC.indexOf("`;", start);
  return AGENT_SRC.slice(start, end);
}
const SYSTEM_PROMPT = extractPrompt();

const nullable = (t: string) => ({ type: [t, "null"] });
const TURN_JSON_SCHEMA = {
  name: "estimating_turn",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["add_item", "update_item", "remove_item", "ambiguous_reference", "kb_proposal"] },
            itemId: nullable("string"),
            description: nullable("string"),
            searchTerm: nullable("string"),
            quantity: nullable("number"),
            unit: nullable("string"),
            action: { type: ["string", "null"], enum: ["remove", "update", null] },
            candidateItemIds: { type: ["array", "null"], items: { type: "string" } },
            referenceText: nullable("string"),
            kbEntryId: nullable("integer"),
          },
          required: ["type", "itemId", "description", "searchTerm", "quantity", "unit", "action", "candidateItemIds", "referenceText", "kbEntryId"],
        },
      },
      reply: { type: "string" },
      isFollowUpQuestion: { type: "boolean" },
      questions: {
        type: ["array", "null"],
        items: { type: "object", additionalProperties: false, properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question", "options"] },
      },
    },
    required: ["operations", "reply", "isFollowUpQuestion", "questions"],
  },
} as const;

/** The seeded company-1 pricebook (35 rows; electrical + labour subset shown). */
const BOOK: [string, string, string, number, string[]][] = [
  ["EL-001", "THHN Copper Wire 12AWG (100ft)", "ROLL", 32, ["wire", "wires", "electrical wire"]],
  ["EL-002", "Toggle Light Switch 15A Single-Pole", "EA", 4.5, ["switch", "switches", "light switch"]],
  ["EL-003", "Electrical Panel 100A 20-space Load Center", "EA", 185, ["panel", "breaker panel", "electrical panel"]],
  ["EL-004", "Electrical Panel 200A 40-space Load Center", "EA", 320, ["panel", "bigger panel", "large panel"]],
  ["EL-005", "Wago 221 Lever Nut Connector (pack of 10)", "PACK", 8.5, ["wago", "wago connector", "lever nut"]],
  ["EL-006", "Circuit Breaker 15A Single-Pole", "EA", 7.25, ["breaker", "circuit breaker", "15 amp breaker", "15a breaker"]],
  ["EL-007", "Circuit Breaker 20A Single-Pole", "EA", 8.5, ["breaker", "circuit breaker", "20 amp breaker", "20a breaker", "branch breaker"]],
  ["EL-008", "Circuit Breaker 30A Double-Pole", "EA", 14.5, ["breaker", "double pole breaker", "30 amp breaker", "30a breaker"]],
  ["EL-009", "Main Breaker 100A", "EA", 46, ["main breaker", "main breaker 100", "100a main"]],
  ["EL-010", "Main Breaker 200A", "EA", 78, ["main breaker", "main breaker 200", "200a main"]],
  ["EL-011", "GFCI Receptacle 20A Self-Test", "EA", 18.98, ["gfci", "gfci receptacle", "gfci outlet", "ground fault outlet"]],
  ["EL-012", 'EMT Conduit 3/4" (10ft)', "STICK", 10.88, ["emt", "emt conduit", "conduit", "electrical conduit"]],
  ["LB-002", "Labor — Tech II Journeyman (per hour)", "HR", 75, ["labor", "journeyman"]],
  ["FA-010", "Notifier FSP-951 Addressable Photo Smoke Detector", "EA", 52, ["smoke detector", "smoke"]],
  ["FA-070", "12V 12AH Fire Alarm Battery", "EA", 28, ["battery", "panel battery"]],
];
const items = BOOK.map(([code, description, unit, unitPrice, synonyms], i) => ({ id: i + 1, code, description, unit, unitPrice, synonyms }));

const CASES = [
  "The outlets in our break room stopped working and the breaker won't stay on",
  "Half the lights in the warehouse are flickering badly",
  "We need two new 20 amp circuits for the copier room",
  "A GFCI outlet by the sink keeps tripping every morning",
  "Our electrical panel is full and we need to add more circuits",
  "The light switch in the hallway sparks when you flip it",
  "We're adding a 240 volt circuit for a new compressor in the shop",
  "Some ceiling lights buzz and one of them died completely",
  "Need to run conduit and wire from the panel to a new machine 40 feet away",
  "An outdoor outlet on the loading dock is corroded and dead",
];

async function turn(
  utterance: string,
  followUpsAsked: number,
  existing: string[],
  /** Prior turns. Without these, a bare "yes" has no proposal to confirm and yields no ops. */
  history: { role: "user" | "assistant"; content: string }[] = []
): Promise<any> {
  const context = `CURRENT LINE ITEMS:
${existing.length ? existing.map((d, i) => `- id=itm${i} | ${d} | qty=1`).join("\n") : "(none yet)"}

KNOWLEDGE BASE ENTRIES (problem → material):
- kbEntryId=5 | problem: Smoke detector chirping, in trouble, or end of life | material: Addressable photo smoke detector | default qty: 1 EA

FOLLOW-UPS ALREADY ASKED FOR THE CURRENT PROBLEM: ${followUpsAsked} of 2 max.

TECHNICIAN SAID:
${utterance}`;
  const { raw } = await callStructured({
    system: SYSTEM_PROMPT,
    userContent: context,
    history,
    jsonSchema: TURN_JSON_SCHEMA,
    model: process.env.ESTIMATE_MODEL || "gpt-5.4",
  });
  return raw ?? { operations: [] };
}

(async () => {
  let totalLines = 0, priced = 0, toHd = 0, noTerm = 0;
  for (const [i, problem] of CASES.entries()) {
    console.log(`\n═══ ${i + 1}. "${problem}"`);
    const t1 = await turn(problem, 2, []);
    let ops = (t1.operations ?? []).filter((o: any) => o.type === "add_item" || o.type === "kb_proposal");
    if (ops.length === 0) {
      // It proposed rather than added; confirm it, carrying the proposal as history.
      const t2 = await turn("yes", 2, [], [
        { role: "user", content: problem },
        { role: "assistant", content: String(t1.reply ?? "") },
      ]);
      ops = (t2.operations ?? []).filter((o: any) => o.type === "add_item" || o.type === "kb_proposal");
      if (ops.length === 0) console.log(`   (still none) t1.reply: ${String(t1.reply ?? "").slice(0, 130)}`);
    }
    if (ops.length === 0) { console.log("   (no line items produced)"); continue; }
    for (const o of ops) {
      totalLines++;
      const term = o.searchTerm?.trim() || null;
      const m = term ? matchPricebook(term, items) : null;
      const viaDesc = !m && o.description ? matchPricebook(o.description, items) : null;
      const hit = m ?? viaDesc;
      let verdict: string;
      if (hit) { priced++; verdict = `PRICED  ${hit.code} $${hit.unitPrice}/${hit.unit}`; }
      else if (term) { toHd++; verdict = `→ HOME DEPOT (searchTerm "${term}")`; }
      else { noTerm++; verdict = "no searchTerm — labour/diagnostic, stays unpriced"; }
      console.log(`   ${verdict}`);
      console.log(`      desc: ${o.description}  [qty ${o.quantity ?? "null"} ${o.unit ?? ""}]`);
    }
  }
  console.log(`\n──── ${totalLines} line items: ${priced} priced from pricebook · ${toHd} to Home Depot · ${noTerm} labour/no-term`);
})().catch((e) => { console.error("harness failed:", e.message); process.exit(1); });

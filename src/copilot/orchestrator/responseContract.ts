/**
 * Shared structured-response contract for the whole copilot.
 *
 * Every agent (general copilot + estimate) emits the SAME discriminated union of
 * typed UI blocks so the frontend has ONE renderer and never conflates two block
 * types. Each block also maps to a distinctly-named SSE frame (see copilot.controller),
 * so a client can dispatch on `block.kind` OR on the SSE event name and still never
 * collapse e.g. `followUps` (suggestion chips) into `questions` (estimate clarifiers)
 * or `actions` (operational CTA buttons).
 *
 * INVARIANT: an unknown `kind` must be rendered as plain markdown and logged — never
 * coerced into another renderer.
 */
import type {
  EstimateQuote,
  FollowUpQuestion,
  IdentifyResult,
} from "../estimate/estimateQuoteSchema";

// Re-export so clients import the whole contract from one module.
export type { EstimateQuote, FollowUpQuestion } from "../estimate/estimateQuoteSchema";
export type Identification = IdentifyResult["identification"];

/** A standards reference (NFPA/NEC/ICC/ASHRAE…), shown inline/footnote style. */
export interface CitationItem {
  standard?: string; // e.g. "NFPA"
  code?: string; // e.g. "25"
  section?: string; // e.g. "5.2.1"
  title: string; // human-readable label
  url?: string;
}

/** RAG / web provenance, shown as a "Sources" list. */
export interface SourceItem {
  type: "file" | "web";
  title: string;
  fileId?: string;
  url?: string;
}

/** An AI-suggested next question. Tapping SENDS `prompt` as a new user message. */
export interface FollowUpChip {
  id: string;
  prompt: string; // text posted as the next `content`
  label: string; // chip label
}

/** Operational CTA that calls an endpoint — NOT a chat message. */
export type CopilotActionType =
  | "preview_estimate"
  | "sign_estimate"
  | "email_estimate"
  | "download_pdf";
export interface ActionItem {
  id: string;
  label: string;
  actionType: CopilotActionType;
  endpoint: string; // fully-qualified or relative API path
  method: "POST" | "GET";
  style?: "primary" | "secondary";
}

/** A quote plus the persisted-turn extras the UI card shows (number, signed state). */
export type QuoteBlockData = EstimateQuote & {
  estimateNumber?: string | null;
  signed?: boolean;
  pdfKey?: string | null;
};

/** The discriminated union the UI switches on. */
export type CopilotBlock =
  | { kind: "markdown"; text: string }
  | { kind: "citations"; items: CitationItem[] }
  | { kind: "sources"; items: SourceItem[] }
  | { kind: "identified"; data: Identification }
  | { kind: "quote"; data: QuoteBlockData }
  | { kind: "questions"; data: { questions: FollowUpQuestion[] } }
  | { kind: "followUps"; items: FollowUpChip[] }
  | { kind: "actions"; items: ActionItem[] };

export type CopilotResponseKind = "message" | "quote" | "questions";

/** The full envelope delivered in the terminal `done` SSE frame and persisted. */
export interface CopilotResponse {
  responseKind: CopilotResponseKind;
  blocks: CopilotBlock[];
}

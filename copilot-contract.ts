/**
 * Copilot client contract — copy this file into the web and mobile apps.
 *
 * Self-contained (no server imports). Mirrors the server's
 * src/copilot/orchestrator/responseContract.ts. The unified endpoint streams NAMED
 * SSE frames; the terminal `done` frame carries a `CopilotResponse` ({responseKind,
 * blocks}). Render each block by switching on `block.kind` — one component per kind.
 */

// ----- Estimate types (mirror of the server's estimate schema) -----
export interface EstimateLineItem {
  sourceSheet: string;
  code: string;
  description: string;
  kind: "material" | "service" | "labor" | "rental" | "permit" | "other";
  quantity: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
  isIdentifiedEquipment: boolean;
}

export interface Identification {
  brand: string;
  model: string;
  category: string;
  issue: string;
  decision: "repair" | "replace";
  confidence: number; // 0-1
}

export interface EstimateQuote {
  status: "estimate" | "needs_info";
  title: string;
  identifiedEquipment: Identification;
  lineItems: EstimateLineItem[];
  materialsServicesSubtotal: number;
  laborSubtotal: number;
  taxOther: number;
  total: number;
  currency: string;
  assumptions: string[];
  customerNotes: string[];
  // Present on a persisted quote turn:
  estimateNumber?: string | null;
  signed?: boolean;
  pdfKey?: string | null;
}

export interface FollowUpQuestionOption {
  id: string;
  label: string;
  value: string; // sent back as `content` when picked
}

export interface FollowUpQuestion {
  id: string;
  question: string;
  options: FollowUpQuestionOption[];
  allowOther: boolean; // always true — show an "Other" free-text/voice entry
}

// ----- Block contract -----
export interface CitationItem {
  standard?: string; // e.g. "NFPA"
  code?: string; // e.g. "25"
  section?: string;
  title: string;
  url?: string;
}

export interface SourceItem {
  type: "file" | "web";
  title: string;
  fileId?: string;
  url?: string;
}

export interface FollowUpChip {
  id: string;
  prompt: string; // POST this as the next `content`
  label: string;
}

export type CopilotActionType =
  | "preview_estimate"
  | "sign_estimate"
  | "email_estimate"
  | "download_pdf";
export interface ActionItem {
  id: string;
  label: string;
  actionType: CopilotActionType;
  endpoint: string; // call this — do NOT send a chat message
  method: "POST" | "GET";
  style?: "primary" | "secondary";
}

export type CopilotBlock =
  | { kind: "markdown"; text: string }
  | { kind: "citations"; items: CitationItem[] }
  | { kind: "sources"; items: SourceItem[] }
  | { kind: "identified"; data: Identification }
  | { kind: "quote"; data: EstimateQuote }
  | { kind: "questions"; data: { questions: FollowUpQuestion[] } }
  | { kind: "followUps"; items: FollowUpChip[] }
  | { kind: "actions"; items: ActionItem[] };

export type CopilotResponseKind = "message" | "quote" | "questions";

export interface CopilotResponse {
  responseKind: CopilotResponseKind;
  blocks: CopilotBlock[];
}

// ----- SSE frame types -----
export type CopilotSseType =
  | "user_message"
  | "thinking"
  | "routing" // { route, reason, source }
  | "node" // { node, phase: "start"|"end" }
  | "chunk" // { content }  — live markdown
  | "tool_call" // { tool }
  | "identified" // { data: Identification }
  | "message" // { content }
  | "citations" // { items: CitationItem[] }
  | "sources" // { items: SourceItem[] }
  | "followUps" // { items: FollowUpChip[] }
  | "quote" // { data: EstimateQuote }
  | "questions" // { data: { questions } }
  | "done" // { data, responseKind, requiresSignature, response: CopilotResponse }
  | "error"; // { error }

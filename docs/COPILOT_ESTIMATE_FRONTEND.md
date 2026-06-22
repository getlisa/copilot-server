# Estimate Cost (Demo) — Frontend Integration Guide

This documents the **Estimate Cost** demo mode for the mobile app. A technician
flips a toggle in the chat bar, snaps a photo of a part (optionally adds a note),
and Clara returns a **full cost estimate** — it identifies the brand/model, decides
**repair vs. replace**, and builds a line-itemized quote (parts/equipment + labor +
lift/access + other costs + total).

> **Demo only.** This is a separate, self-contained endpoint built for the
> conference. It does **not** change the normal copilot chat
> ([COPILOT_FRONTEND.md](COPILOT_FRONTEND.md)) — same conversation, same SSE
> framing, just a different endpoint and one extra event (`quote`). Pricing comes
> from the fire-protection pricebook (`docs/EQUIPMENT_DATA.md`).

---

## The toggle in the chat bar

Add an **"Estimate Cost"** toggle button to the chat input bar (e.g. a `$`/receipt
icon next to the camera). It is a simple on/off switch:

- **OFF (default):** sends to the normal copilot — `POST /api/v1/copilot/:id/stream`.
- **ON:** the next send routes to the **estimate endpoint** below. Show an
  "Estimate mode" chip above the composer and (optionally) nudge the camera so the
  tech attaches a photo. Auto-turn-off after one estimate, or leave it sticky —
  your call.

```
┌─────────────────────────────────────────────┐
│  [ Estimate mode ●]                           │  ← chip shown when ON
│  ┌───────────────────────────────────────┐   │
│  │  📷   "head is leaking"            ➤   │   │
│  └───────────────────────────────────────┘   │
│   📷 camera   $ Estimate (toggle)             │  ← toggle lives here
└─────────────────────────────────────────────┘
```

---

## Endpoint

```
POST /api/v1/copilot/:conversationId/estimate/stream
Content-Type: application/json
Accept: text/event-stream
```

`:conversationId` is an existing conversation UUID (create it the same way you do
today via `POST /api/v1/conversations`).

### Request body

| Field           | Type             | Required           | Notes                                                       |
| --------------- | ---------------- | ------------------ | ----------------------------------------------------------- |
| `content`       | string           | see note           | The technician's description (e.g. "this head is leaking"). |
| `imageUrl`      | string (URL)     | see note           | A public/presigned URL of the photo.                        |
| `imageBase64`   | string           | see note           | Base64 of the photo (no `data:` prefix).                    |
| `imageMimeType` | string           | no                 | e.g. `image/jpeg`. Used with `imageBase64`. Defaults to JPEG. |
| `senderId`      | string \| number | no                 | User id. Falls back to the conversation's owner.            |

> **At least one of** `content`, `imageUrl`, or `imageBase64` is required. For the
> demo the compelling path is **a photo** (`imageUrl` or `imageBase64`) plus an
> optional one-line `content`.

```json
{
  "content": "This sprinkler head is corroded and leaking at the seat.",
  "imageUrl": "https://…/sprinkler.jpg",
  "senderId": "123"
}
```

> ⚠️ This is **SSE over POST**, so you cannot use the browser `EventSource` API.
> Use `fetch` + a streaming reader (example below) — identical to the normal copilot.

---

## Response: SSE stream

Same framing as the copilot: each frame has a named `event:` line and a JSON
`data:` payload (the payload repeats the name in its `type` field). Lines starting
with `:` are heartbeats — ignore them.

> **⚠ Breaking change.** The estimate no longer token-streams the quote as
> markdown. The old `chunk` event is replaced by a single **`message`** event, and
> the structured payload is now **either** a `quote` **or** a `questions` event.
> `done` carries a **`responseKind`** that tells you exactly what the turn produced.
> Show an "Estimating…" spinner between `thinking` and `message` (no live typing).

> **Behind the scenes** the estimate runs as a small LangGraph workflow
> (`identify → build_quote | ask_questions`). It emits additive **`node`** (step
> progress) and **`identified`** (early equipment ID) frames — purely optional; the
> core `message`/`quote`/`questions`/`done` contract is unchanged, so you can ignore
> them or use them for a progress stepper.

### Event types

| `type`         | Payload                                  | UI meaning |
| -------------- | ---------------------------------------- | ---------- |
| `user_message` | `{ data: Message }`                      | The persisted user message. Render/confirm it. |
| `thinking`     | `{}`                                     | Started. Show an "Estimating…" spinner. |
| `node`         | `{ node, phase: "start"\|"end" }`        | *(optional)* graph step progress. `node ∈ identify \| build_quote \| ask_questions`. Drive a stepper ("Identifying… → Pricing…"). |
| `identified`   | `{ data: IdentifiedEquipment \| null }`  | *(optional)* equipment recognized early (brand/model/category/issue/decision/confidence). Show a preview chip. |
| `message`      | `{ content: string }`                    | **RENDER** — the assistant's chat-bubble text (concise markdown). |
| `quote`        | `{ data: EstimateQuote }`                | **FORMAT** — render the quote card. Sent only on a quote turn. |
| `quote_pdf`    | `{ url, key, filename }`                 | *(quote turns)* the generated quotation PDF — a presigned, downloadable URL. Show a **"Download PDF"** button. |
| `questions`    | `{ data: { questions: FollowUpQuestion[] } }` | **FORMAT** — render option buttons + "Other". Sent only on a questions turn. |
| `done`         | `{ data: Message, responseKind }`        | Final state. `responseKind ∈ "quote" \| "questions" \| "message"`. |
| `error`        | `{ error: string }`                      | Something failed. Surface a retry. |

**Exactly one** of `quote` / `questions` is sent per turn (or neither, for a plain
`message`). `done.responseKind` is the authoritative signal of what to show:

```
quote turn:     user_message → thinking
  → node:identify(start) → identified → node:identify(end)
  → node:build_quote(start) → message → quote → node:build_quote(end)
  → quote_pdf → done

questions turn: user_message → thinking
  → node:identify(start) → identified → node:identify(end)
  → node:ask_questions(start) → message → questions → node:ask_questions(end) → done
```

If you don't want the progress UI, just handle `message` / `quote` / `questions` /
`done` and ignore `node` / `identified`.

- `responseKind: "quote"`     → a `quote` event was sent → render the bubble + card.
- `responseKind: "questions"` → a `questions` event was sent → render the bubble + buttons.
- `responseKind: "message"`   → neither → render the bubble only.

The same values are mirrored on `done.data.metadata.responseKind`, with the quote /
questions in `metadata.quote` / `metadata.questions` — use those to **rehydrate** the
card/buttons when reloading conversation history.

---

## The `quote` payload (`EstimateQuote`)

> **⚠ Breaking change (pricebook update):** the quote shape changed to match the
> pricebook's quotation format. Line items now carry `sourceSheet` + `code` +
> `unit`, use `lineTotal` (not `amount`), and totals split into
> `materialsServicesSubtotal` / `laborSubtotal` / `taxOther` / `total` (the old
> `lineItems[].amount`, `laborHours`, `subtotal`, `notes` fields are gone). Update
> the card to read the fields below.

The card renders the line items grouped by Materials+Services vs. Labor, with the
three subtotals and the total. The streamed markdown bubble (above the card) still
contains the full quotation + NFPA "Notes for Customer".

> **Readiness:** the `quote` frame is only emitted when the copilot produced a
> **complete** quotation (real line items + a numeric total). When it is asking
> follow-up questions instead, **no `quote` frame is sent** — render only the
> streamed text. (`status` is always `"estimate"` for any quote you receive.)

```ts
interface EstimateQuote {
  status: "estimate" | "needs_info"; // you will only ever receive "estimate"
  title: string;                     // "Loading Dock — Painted Head Replacement"
  identifiedEquipment: {
    brand: string;                   // proactively chosen, e.g. "Tyco"
    model: string;                   // e.g. "TY3151 (or equiv.)"
    category: string;                // "Pendant sprinkler head"
    issue: string;
    decision: "repair" | "replace";
    confidence: number;              // 0..1
  };
  lineItems: Array<{
    sourceSheet: string;             // "Sprinkler Materials" | "Labor Benchmarks" | …
    code: string;                    // "SP-010" | "LH-002" | "SV-002" | "LB-030"
    description: string;
    kind: "material" | "service" | "labor" | "rental" | "permit" | "other";
    quantity: number;                // qty, or hours for labor
    unit: string;                    // "EA" | "HR" | "RL" | "DAY" | "CALL" | …
    unitPrice: number;
    lineTotal: number;               // quantity * unitPrice
  }>;
  materialsServicesSubtotal: number; // sum of non-labor lineTotals
  laborSubtotal: number;             // sum of labor lineTotals
  taxOther: number;                  // 0 unless applicable
  total: number;                     // materials+services + labor + tax
  currency: string;                  // "USD"
  assumptions: string[];
  customerNotes: string[];           // NFPA compliance flags / advisories
}
```

### Suggested quote-card layout

```
┌──────────────────────────────────────────────────────────────┐
│  Tyco TY3151 (or equiv.) · pendant · REPLACE        (0.9 ✓)    │  identifiedEquipment
│  Painted over — non-compliant                                  │  .issue
├──────────────────────────────────────────────────────────────┤
│  CODE    DESCRIPTION                  QTY  UNIT  PRICE   TOTAL  │  lineItems
│  SP-005  Upright head 200°F            1   EA    $5.90   $5.90  │  kind=material
│  LH-002  Replace head — drop ceiling  0.63 HR    $75    $47.25  │  kind=labor
│  LI-001  Drain wet system              2.0 HR    $75    $150    │  kind=labor
│  LB-030  Scissor lift 19ft (day)       1   DAY   $245   $245    │  kind=rental
├──────────────────────────────────────────────────────────────┤
│  Materials + Services                                  $5.90   │  materialsServicesSubtotal
│  Labor                                               $197.25   │  laborSubtotal
│  Tax / Other                                            $0.00   │  taxOther
│  TOTAL QUOTE                                         $448.15    │  total + currency
├──────────────────────────────────────────────────────────────┤
│  ⚠ Notes for customer                                          │  customerNotes
│  • Painted heads are non-compliant (NFPA 25)…                  │
└──────────────────────────────────────────────────────────────┘
```

Group rows by `kind` (materials/services vs. labor vs. rentals/permits) if you like,
show a colored `kind` chip, and list `customerNotes` + `assumptions` under collapsible
rows. Render `lineTotal`/`total` as currency.

---

## Quotation PDF (`quote_pdf`)

On every quote turn the backend renders a branded PDF quotation (Clara logo, company
+ customer addresses, the line-item table, totals, signature, terms), stores it in
S3, and emits a **`quote_pdf`** frame with a **presigned, downloadable** URL:

```ts
// quote_pdf payload
{ url: string; key: string; filename: string }  // e.g. filename "Estimate-E0ABC12.pdf"
```

- Show a **"Download PDF"** button that opens `url` (it serves with
  `Content-Disposition: attachment`, so it downloads rather than rendering inline).
- If the user uploaded an equipment photo, it's embedded as a **thumbnail on the
  matching line item** automatically — nothing to do on the client.
- The key is also persisted at `done.data.metadata.quote.pdfKey` (with
  `metadata.quote.estimateNumber`).

### Re-download later (presigned URLs expire)

The `quote_pdf` URL is time-limited (~24h). To get a fresh link for a saved quote:

```
GET /api/v1/copilot/:conversationId/estimate/:messageId/pdf
→ 302 redirect to a fresh presigned download URL
```

Use the AI message's `id` as `:messageId`. Just point a download/`<a download>` at this
endpoint — it always re-presigns, so links never go stale. Returns 404 if that message
has no PDF (e.g. a questions turn).

---

## The `questions` payload (`FollowUpQuestion`)

When the request is too vague to price, the copilot asks the **required** questions
instead of guessing. Render each as a prompt with its `options` as tappable buttons,
plus an always-present **"Other"** entry for typed/spoken free text.

```ts
interface FollowUpQuestion {
  id: string;                      // e.g. "ceiling_type"
  question: string;                // shown above the buttons
  options: Array<{
    id: string;
    label: string;                 // button text, e.g. "Drop tile ceiling"
    value: string;                 // the answer text to send back when tapped
  }>;
  allowOther: boolean;             // always true → show an "Other" (type/speak) entry
}
```

```
┌──────────────────────────────────────────────┐
│  To price this I need a couple of details:     │  ← message event
├──────────────────────────────────────────────┤
│  What type of ceiling?                         │  questions[0].question
│  [ Open/exposed ] [ Drop tile ] [ Drywall ]    │  options (buttons)
│  [ ✎ Other ]                                   │  allowOther
├──────────────────────────────────────────────┤
│  Roughly how high?                             │  questions[1].question
│  [ <10ft ] [ 10–14ft ] [ 14–20ft ] [ ✎ Other ]│
└──────────────────────────────────────────────┘
```

### Answering — round-trip

Selecting an option (or submitting "Other") sends the answer **back to the same
endpoint** as `content`, in the **same conversation**. The server keeps short history,
so the copilot remembers what it asked and returns a `quote` (or asks the next
required question). Send the option's `value` (or the free text):

```ts
// one question: just send the chosen value
streamEstimate(API_BASE, conversationId, { content: chosenOption.value }, handlers);

// multiple questions answered at once: combine into one message
const answer = answered.map((a) => `${a.question}: ${a.value}`).join("; ");
streamEstimate(API_BASE, conversationId, { content: answer }, handlers);
```

---

## Client example (TypeScript, framework-agnostic)

```ts
export interface EstimateEvent {
  type: "user_message" | "thinking" | "node" | "identified" | "message" | "quote" | "quote_pdf" | "questions" | "done" | "error";
  data?: any;            // user_message/quote/identified: payload · questions: { questions } · done: Message
  content?: string;      // message: the chat-bubble text
  node?: string;         // node: "identify" | "build_quote" | "ask_questions"
  phase?: "start" | "end"; // node: lifecycle phase
  url?: string; key?: string; filename?: string; // quote_pdf
  responseKind?: "quote" | "questions" | "message"; // on `done`
  error?: string;
}

export async function streamEstimate(
  baseUrl: string,
  conversationId: string,
  body: {
    content?: string;
    imageUrl?: string;
    imageBase64?: string;
    imageMimeType?: string;
    senderId?: string | number;
  },
  handlers: {
    onUserMessage?: (m: any) => void;
    onThinking?: () => void;
    onNode?: (node: string, phase: "start" | "end") => void;     // optional progress
    onIdentified?: (equipment: any) => void;                      // optional
    onMessage?: (text: string) => void;
    onQuote?: (quote: any) => void;
    onQuotePdf?: (pdf: { url: string; key: string; filename: string }) => void;
    onQuestions?: (questions: any[]) => void;
    onDone?: (message: any, responseKind: string) => void;
    onError?: (msg: string) => void;
  },
  signal?: AbortSignal
) {
  const res = await fetch(
    `${baseUrl}/api/v1/copilot/${conversationId}/estimate/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    }
  );
  if (!res.ok || !res.body) throw new Error(`Estimate request failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue; // heartbeat / comment
      const json = line.slice(5).trim();
      if (!json) continue;
      const ev: EstimateEvent = JSON.parse(json);
      switch (ev.type) {
        case "user_message": handlers.onUserMessage?.(ev.data); break;
        case "thinking":     handlers.onThinking?.(); break;
        case "node":         handlers.onNode?.(ev.node!, ev.phase!); break;
        case "identified":   handlers.onIdentified?.(ev.data); break;
        case "message":      handlers.onMessage?.(ev.content ?? ""); break;
        case "quote":        handlers.onQuote?.(ev.data); break;
        case "quote_pdf":    handlers.onQuotePdf?.({ url: ev.url!, key: ev.key!, filename: ev.filename! }); break;
        case "questions":    handlers.onQuestions?.(ev.data?.questions ?? []); break;
        case "done":         handlers.onDone?.(ev.data, ev.responseKind ?? "message"); break;
        case "error":        handlers.onError?.(ev.error ?? "Unknown error"); break;
      }
    }
  }
}
```

### React usage sketch

```tsx
const [estimateMode, setEstimateMode] = useState(false); // chat-bar toggle
const [busy, setBusy] = useState(false);                 // show "Estimating…" spinner
const [text, setText] = useState("");
const [quote, setQuote] = useState<EstimateQuote | null>(null);
const [questions, setQuestions] = useState<FollowUpQuestion[] | null>(null);
const abort = useRef<AbortController>();

async function send(content: string, photo?: { base64: string; mime: string }) {
  abort.current = new AbortController();

  if (estimateMode) {
    setText(""); setQuote(null); setQuestions(null); setBusy(true);
    await streamEstimate(
      API_BASE,
      conversationId,
      { content, imageBase64: photo?.base64, imageMimeType: photo?.mime },
      {
        onThinking:  () => setBusy(true),
        onMessage:   (t) => setText(t),         // arrives once (no token streaming)
        onQuote:     (q) => setQuote(q),         // render the card
        onQuestions: (qs) => setQuestions(qs),   // render option buttons
        onDone:      () => setBusy(false),
        onError:     () => setBusy(false),
      },
      abort.current.signal
    );
  } else {
    // …normal copilot stream (see COPILOT_FRONTEND.md)…
  }
}

// Tapping an option (or submitting "Other") just calls send() again with the value:
function answer(option: { value: string }) { setQuestions(null); send(option.value); }
```

---

## Demo script (suggested)

1. Open a conversation. Flip the **Estimate Cost** toggle ON — chip appears.
2. Tap the camera, snap the sprinkler head, add "leaking at the seat", send.
3. Watch "Estimating…", then the assistant message + quote card appear together.
4. The **quote card** pops with the identified head (e.g. **Tyco TY3151, or
   equiv.**), repair-vs-replace, the priced line items (materials + labor by
   pricebook code), the subtotals, and the **TOTAL QUOTE**.
5. (Optional) Toggle OFF and ask a normal follow-up to show both modes share the
   same conversation.

---

## Operational notes

- **Photo input:** prefer `imageBase64` for a captured photo (no upload round-trip),
  or pass a presigned `imageUrl` if you already upload images. The image goes to the
  `identify` node (vision); pricing happens in a follow-on `build_quote` node.
- **Persistence:** the user message and the final AI message are persisted
  automatically; the AI message carries `metadata.mode = "estimate"`,
  `metadata.responseKind`, and `metadata.quote` / `metadata.questions`. No extra
  save call. Use these to rehydrate the card/buttons in conversation history.
- **Abort:** abort the `fetch` on unmount/navigation; the server aborts the model
  run when the client disconnects.
- **Markdown:** the assistant `content` is markdown; render with your existing renderer.
- **Auth:** currently public (parity with `/api/v1/copilot` and `/api/v1/chat`).

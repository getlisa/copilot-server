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

### Event types

| `type`         | Payload                            | Meaning / UI hint                                                    |
| -------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `user_message` | `{ data: Message }`                | The persisted user message (with the photo). Render/confirm it.      |
| `thinking`     | `{}`                               | Estimating started. Show "Estimating…".                              |
| `chunk`        | `{ content: string }`              | A piece of the markdown estimate. **Append** to the streaming bubble. |
| `quote`        | `{ data: EstimateQuote }`          | **The structured quote.** Render the quote card (see below).         |
| `done`         | `{ data: Message }`                | Final persisted AI message (full markdown in `data.content`).        |
| `error`        | `{ error: string }`                | Something failed. Surface a retry.                                   |

Typical order:

```
user_message → thinking → chunk* → quote → done
```

`quote` arrives once, just before `done`. It is best-effort: if it's missing,
fall back to rendering the streamed markdown only.

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

## Client example (TypeScript, framework-agnostic)

```ts
export interface EstimateEvent {
  type: "user_message" | "thinking" | "chunk" | "quote" | "done" | "error";
  data?: any;
  content?: string;
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
    onChunk?: (text: string) => void;
    onQuote?: (quote: any) => void;
    onDone?: (message: any) => void;
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
        case "chunk":        handlers.onChunk?.(ev.content ?? ""); break;
        case "quote":        handlers.onQuote?.(ev.data); break;
        case "done":         handlers.onDone?.(ev.data); break;
        case "error":        handlers.onError?.(ev.error ?? "Unknown error"); break;
      }
    }
  }
}
```

### React usage sketch

```tsx
const [estimateMode, setEstimateMode] = useState(false); // chat-bar toggle
const [text, setText] = useState("");
const [quote, setQuote] = useState<EstimateQuote | null>(null);
const abort = useRef<AbortController>();

async function send(content: string, photo?: { base64: string; mime: string }) {
  abort.current = new AbortController();

  if (estimateMode) {
    setText(""); setQuote(null);
    await streamEstimate(
      API_BASE,
      conversationId,
      { content, imageBase64: photo?.base64, imageMimeType: photo?.mime },
      {
        onChunk: (t) => setText((p) => p + t),
        onQuote: (q) => setQuote(q),
        onDone: (m) => setText(m.content),
        onError: () => {/* show retry */},
      },
      abort.current.signal
    );
  } else {
    // …normal copilot stream (see COPILOT_FRONTEND.md)…
  }
}
```

---

## Demo script (suggested)

1. Open a conversation. Flip the **Estimate Cost** toggle ON — chip appears.
2. Tap the camera, snap the sprinkler head, add "leaking at the seat", send.
3. Watch "Estimating…", then the markdown estimate streams in.
4. The **quote card** pops with the identified head (e.g. **Tyco TY3151, or
   equiv.**), repair-vs-replace, the priced line items (materials + labor by
   pricebook code), the subtotals, and the **TOTAL QUOTE**.
5. (Optional) Toggle OFF and ask a normal follow-up to show both modes share the
   same conversation.

---

## Operational notes

- **Photo input:** prefer `imageBase64` for a captured photo (no upload round-trip),
  or pass a presigned `imageUrl` if you already upload images. The image is sent to
  a vision model; only `content` is reused for the structured pass (image isn't re-sent).
- **Persistence:** the user message and the final AI message are persisted
  automatically; the AI message carries `metadata.mode = "estimate"` and
  `metadata.quote`. No extra save call.
- **Abort:** abort the `fetch` on unmount/navigation; the server aborts the model
  run when the client disconnects.
- **Markdown:** the assistant `content` is markdown; render with your existing renderer.
- **Auth:** currently public (parity with `/api/v1/copilot` and `/api/v1/chat`).

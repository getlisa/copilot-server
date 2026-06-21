# Estimate Cost (Demo) — Frontend Integration Guide

This documents the **Estimate Cost** demo mode for the mobile app. A technician
flips a toggle in the chat bar, snaps a photo of a part (optionally adds a note),
and Clara returns a **full cost estimate** — it identifies the brand/model, decides
**repair vs. replace**, and builds a line-itemized quote (parts/equipment + labor +
lift/access + other costs + total).

> **Demo only.** This is a separate, self-contained endpoint built for the
> conference. It does **not** change the normal copilot chat
> ([COPILOT_FRONTEND.md](COPILOT_FRONTEND.md)) — same conversation, same SSE
> framing, just a different endpoint and one extra event (`quote`). Pricing is
> illustrative.

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

```ts
interface EstimateQuote {
  identifiedEquipment: {
    brand: string;
    model: string;
    category: string;        // e.g. "Fire sprinkler head"
    issue: string;
    decision: "repair" | "replace";
    confidence: number;      // 0..1
  };
  lineItems: Array<{
    label: string;
    type: "equipment" | "part" | "labor" | "access" | "other";
    quantity: number;        // qty, or hours for labor
    unitCost: number;
    amount: number;          // quantity * unitCost
  }>;
  laborHours: number;
  laborRate: number;
  subtotal: number;
  total: number;
  currency: string;          // "USD"
  assumptions: string[];
  notes: string;
}
```

### Suggested quote-card layout

```
┌─────────────────────────────────────────────┐
│  Tyco TY-FRB pendent  ·  REPLACE   (0.86 ✓)   │  identifiedEquipment
│  Corroded, leaking at the seat                │  .issue
├─────────────────────────────────────────────┤
│  Item                     Qty   Unit   Amount │  lineItems table
│  Tyco TY-FRB head          1    $18     $18   │
│  Brass escutcheon          1     $6      $6   │
│  Field labor             0.5h   $95     $48   │
│  Disposal fee              1    $25     $25   │
├─────────────────────────────────────────────┤
│  Estimated total                       $97    │  total + currency
│  Demo estimate — confirmed on site            │  notes
└─────────────────────────────────────────────┘
```

Color the `type` chips (equipment/part/labor/access/other) and show
`assumptions` under a collapsible "Assumptions" row.

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
4. The **quote card** pops with identified **Tyco TY-FRB**, repair-vs-replace,
   line items, and an **estimated total**.
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

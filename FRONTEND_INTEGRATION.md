# Copilot Frontend Integration Guide (web + mobile)

This guide is for the frontend coding agent updating **both** the web app
(`voice-sandwich-demo/components/web/src`) and the mobile app to consume the new
**unified copilot orchestrator**. Copy [`copilot-contract.ts`](./copilot-contract.ts)
into each app for typed rendering.

## What changed

- There is now **one** copilot endpoint that auto-routes between the general
  assistant and the cost-estimate agent. The user no longer has to toggle a mode.
- Every response is a **structured stream of typed blocks** (`CopilotResponse.blocks`)
  — render one component per `block.kind`, never a shared renderer.
- **Breaking:** the chat stream moved from anonymous `data:` frames to **named**
  SSE events (`event: <type>`). Clients reading bare `onmessage` must switch to
  per-event dispatch. Clients that already read `data.type` keep working. (Web voice
  over WebSocket is unaffected.)

---

## 1. Endpoint & request

`POST /api/v1/copilot/:conversationId/stream`

```jsonc
{
  "content": "string",                 // user text (required unless image-only)
  "senderId": "string|number",         // omit/null for AI-authored messages
  "mode": "estimate" | "general",       // OPTIONAL explicit toggle — router treats it as a prior
  "imageUrls": ["https://…"],            // optional vision images (presigned URLs or data URLs)
  "selectedImageIds": ["…"],             // optional: explicit ImageFile ids to attach
  "images": ["data:image/...;base64,…"]  // optional inline images (alias: inlineImages)
}
```

Headers: `x-device-timezone` (IANA tz, e.g. `America/New_York`) so job-context
timestamps render in the technician's zone.

Non-streaming variant: `POST /api/v1/copilot/:conversationId/send` → returns
`{ success, data: { userMessage, aiMessage, response } }`.

---

## 2. SSE transport — the one real web/mobile difference

Frames are **named events**:

```
event: chunk
data: {"type":"chunk","content":"Hold the menu button…"}

event: routing
data: {"type":"routing","route":"estimate","reason":"User asked for a price.","source":"llm"}
```

`EventSource` can't issue POST, so both platforms use a manual reader.

### Web — `fetch` + ReadableStream

```ts
export async function streamCopilot(
  url: string,
  body: unknown,
  onEvent: (type: string, data: any) => void,
  signal?: AbortSignal
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone },
    body: JSON.stringify(body),
    signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (!frame.trim() || frame.startsWith(":")) continue; // ignore heartbeats
      let eventType = "message";
      let dataLine = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (dataLine) onEvent(eventType, JSON.parse(dataLine));
    }
  }
}
```

Cancel by aborting the `AbortController` on unmount.

### Mobile (React Native) — `react-native-sse`

`fetch`'s streaming body is unreliable in RN; use **`react-native-sse`** (supports
POST + custom headers + named listeners):

```ts
import EventSource from "react-native-sse";

const es = new EventSource(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-device-timezone": tz },
  body: JSON.stringify(body),
});
["chunk","routing","node","tool_call","identified","message","citations","sources",
 "followUps","quote","questions","user_message","thinking","done","error"]
  .forEach((t) => es.addEventListener(t as any, (e: any) => onEvent(t, JSON.parse(e.data))));
// es.close() on unmount / after `done`.
```

(Alternative: an XHR `onprogress` buffer-splitter using the same `\n\n` parsing.)

---

## 3. Event → state reducer

Keep a per-AI-message object `{ streamingText, blocks: CopilotBlock[], status }`:

| event | action |
|---|---|
| `user_message` | render the echoed user bubble |
| `thinking` | show typing indicator |
| `routing` | optional "Routing to {route}…" reasoning hint |
| `node` | optional step indicator ("Identifying…", "Building quote…") from `{node,phase}` |
| `chunk` | append `content` to `streamingText` (the live markdown bubble) |
| `tool_call` | optional "Searched knowledge base / web" pill |
| `identified`/`quote`/`questions`/`citations`/`sources`/`followUps` | push the matching block |
| `done` | finalize — **prefer `done.response.blocks` as the source of truth** (idempotent re-render); persist `data` (aiMessage) to history |
| `error` | error state |

On reload, re-render from the persisted `aiMessage.metadata.blocks` (same `CopilotBlock[]`).

---

## 4. Block renderers — one component per `kind` (do NOT share)

Switch on `block.kind`. **Unknown `kind` → render as markdown and log; never coerce
into another renderer.** The three "tappable" kinds are deliberately distinct:

| `kind` | renderer | on interaction |
|---|---|---|
| `markdown` | streamed text bubble (render markdown) | — |
| `citations` | inline/footnote standards refs (e.g. "NFPA 25 §5.2") | open `url` if present |
| `sources` | "Sources" list, file/web icon + link | open source |
| `identified` | equipment ID card (brand/model/decision/confidence) | — |
| `quote` | full quotation card (line items, subtotals, total) | — |
| `questions` | **grouped** clarifier questions; each with option buttons + free-text "Other" | selecting an option **sends a new turn** with `content = option.value` |
| `followUps` | flat row of **suggestion chips** | tapping **sends a new turn** with `content = chip.prompt` |
| `actions` | primary/secondary **CTA buttons** | calls `endpoint`/`method` — **NOT a chat message** |

Why they must not collide: `questions` are model-required clarifiers that block the
quote; `followUps` are optional AI suggestions; `actions` are operational API calls.

---

## 5. Estimate lifecycle actions (the `actions` block)

`actions` items carry `actionType` + `endpoint` + `method`. Map them:

- **`preview_estimate`** → `GET /api/v1/copilot/:cid/estimate/:mid/preview` — streams an **unsigned draft** quotation PDF (`Content-Type: application/pdf`, served `inline`). Available as soon as the quote exists (before signing). Let the user click to **view the estimate before committing a signature**. Web: open in a new tab / embed in an `<iframe>`/`<embed>`. Mobile: open in the in-app PDF viewer. Append `?download=1` to force a download instead of inline view.
- **`sign_estimate`** → `POST /api/v1/copilot/:cid/estimate/:mid/sign`
  `{ signatureBase64, signatureMimeType?, signerName? }` →
  `{ url, directUrl, estimateNumber, suggestedCustomerEmail }`.
  - Web: HTML canvas signature pad → PNG data URL.
  - Mobile: `react-native-signature-canvas`.
- **`email_estimate`** → `POST /api/v1/copilot/:cid/estimate/:mid/email` `{ to }`
  (prefill with `suggestedCustomerEmail` from the sign response).
- **`download_pdf`** → `GET /api/v1/copilot/:cid/estimate/:mid/pdf` (append `?inline=1`
  to view in browser). Web: open in a new tab. Mobile: download / share sheet.

The PDF only exists **after** signing; `download_pdf`/`email_estimate` return 409
until then.

---

## 6. Images

- Web: file picker → presigned upload → pass `imageUrls` (or `selectedImageIds`).
- Mobile: image picker → presigned upload → same fields. Inline base64 also works via
  `images` (data URLs) for small photos.

---

## 7. Migration checklist

- [ ] Add the named-event SSE reader (web) / `react-native-sse` (mobile).
- [ ] Replace any bare `onmessage` handler with per-event dispatch.
- [ ] Add the block renderer switch (one component per `kind`) with the unknown-kind
      fallback.
- [ ] Wire `questions`/`followUps` taps to new `/stream` turns, and `actions` taps to
      their endpoints.
- [ ] Point the chat screen at `POST /api/v1/copilot/:id/stream` (the legacy
      `/api/v1/chat/:id/stream` still works but now emits named frames too).

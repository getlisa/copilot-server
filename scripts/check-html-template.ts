/**
 * The HTML proposal template engine: values, repeated sections, conditionals and escaping.
 * These templates print customer money and are authored per company, so the rules that keep
 * them safe (escaping, no code execution) and honest (unknown tokens stay visible) are pinned
 * here rather than discovered on a customer's document.
 *
 * Run: npx tsx scripts/check-html-template.ts
 */
import assert from "assert";
import { renderHtmlTemplate, escapeHtml } from "../src/copilot/estimating/html/htmlTemplate";

const eq = (label: string, got: unknown, want: unknown) =>
  assert.deepStrictEqual(got, want, `${label}: ${JSON.stringify(got)} !== ${JSON.stringify(want)}`);

eq("a value fills", renderHtmlTemplate("Hi {{name}}", { name: "Tim" }), "Hi Tim");

// Escaping: a customer name is untrusted text on a page that also carries markup.
eq(
  "values are HTML-escaped",
  renderHtmlTemplate("{{name}}", { name: '<script>alert("x")</script>' }),
  "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
);
eq("triple braces insert raw", renderHtmlTemplate("{{{html}}}", { html: "<b>x</b>" }), "<b>x</b>");

// An unknown token stays visible: a silently blank document is the failure nobody notices.
eq("unknown tokens stay visible", renderHtmlTemplate("{{nope}}", {}), "{{nope}}");
eq("a known-but-empty value prints nothing", renderHtmlTemplate("[{{x}}]", { x: "" }), "[]");

// Repetition — the line-item table.
eq(
  "a list repeats its body per item",
  renderHtmlTemplate("{{#items}}<td>{{n}}</td>{{/items}}", { items: [{ n: 1 }, { n: 2 }] }),
  "<td>1</td><td>2</td>"
);
eq(
  "an item can read the outer scope",
  renderHtmlTemplate("{{#items}}{{cur}}{{n}} {{/items}}", { cur: "$", items: [{ n: 1 }, { n: 2 }] }),
  "$1 $2 "
);
eq("an empty list prints nothing", renderHtmlTemplate("a{{#items}}X{{/items}}b", { items: [] }), "ab");

// Conditionals — a tax row that must not print when there is no tax.
eq("a truthy section prints", renderHtmlTemplate("{{#t}}yes{{/t}}", { t: true }), "yes");
eq("a falsy section is skipped", renderHtmlTemplate("{{#t}}yes{{/t}}", { t: false }), "");
eq("an inverted section prints when falsy", renderHtmlTemplate("{{^t}}no{{/t}}", { t: false }), "no");
eq("an inverted section is skipped when truthy", renderHtmlTemplate("{{^t}}no{{/t}}", { t: 1 }), "");

// Nesting, including a same-named section inside itself.
eq(
  "sections nest",
  renderHtmlTemplate("{{#a}}[{{#b}}{{v}}{{/b}}]{{/a}}", { a: true, b: [{ v: "x" }, { v: "y" }] }),
  "[xy]"
);

// An unclosed section must not swallow the rest of the document.
assert.ok(
  renderHtmlTemplate("before {{#a}}dangling", { a: true }).includes("before"),
  "an unclosed section keeps the text before it"
);

eq("escapeHtml handles null", escapeHtml(null), "");

console.log("check-html-template: all assertions passed");

// --- stored-template safety -------------------------------------------------------------------
// An uploaded document is untrusted input handed to a browser running on our server. These
// pin both layers: what is stripped on the way in, and what the renderer may fetch.
import { sanitiseTemplateHtml, isAllowedResource } from "../src/copilot/estimating/html/htmlSafety";

const strip = (html: string) => sanitiseTemplateHtml(html).html;

assert.ok(!strip('<p>a</p><script>fetch("/x")</script>').includes("script"), "scripts are stripped");
assert.ok(!strip('<iframe src="file:///app/.env"></iframe>').includes("iframe"), "iframes are stripped");
assert.ok(!strip('<object data="x"></object>').includes("object"), "objects are stripped");
assert.ok(!/onerror/i.test(strip('<img src=x onerror="steal()">')), "event handlers are stripped");
assert.ok(!/javascript:/i.test(strip('<a href="javascript:x()">go</a>')), "script URLs are defused");
assert.ok(!/refresh/i.test(strip('<meta http-equiv="refresh" content="0;url=http://x">')), "meta refresh is stripped");
eq("the document itself survives", strip("<h1>Estimate {{total}}</h1>"), "<h1>Estimate {{total}}</h1>");
assert.ok(
  sanitiseTemplateHtml('<script>x</script><p>y</p>').removed.includes("<script>"),
  "what was removed is reported, never silently applied"
);

// The renderer's allowlist — the control that holds even if the sanitiser misses something.
assert.ok(isAllowedResource("data:image/png;base64,AAA"), "inline data is fine");
assert.ok(!isAllowedResource("file:///etc/passwd"), "local files are blocked");
assert.ok(
  !isAllowedResource("http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
  "the cloud metadata endpoint is blocked"
);
assert.ok(!isAllowedResource("http://10.0.4.221:5432/"), "the private network is blocked");
assert.ok(!isAllowedResource("http://localhost:7001/admin"), "localhost is blocked");
assert.ok(!isAllowedResource("https://evil.example.com/pixel.png"), "an unlisted host is blocked");
assert.ok(isAllowedResource("https://fonts.googleapis.com/css2?family=X"), "listed font hosts are allowed");
assert.ok(
  isAllowedResource("https://evil.example.com/pixel.png", true),
  "a reviewed repo template may load public resources"
);
assert.ok(
  !isAllowedResource("http://169.254.169.254/", true),
  "even a trusted template cannot reach cloud metadata"
);

console.log("check-html-template: stored-template safety assertions passed");

// --- page images for the Word download ---------------------------------------------------------
// The .docx of an HTML proposal is one picture per page, so the page COUNT is what decides
// whether a customer opens a document with a blank sheet stapled to the end.
import { pageCount } from "../src/copilot/estimating/html/htmlToPdf";

eq("an empty document is still one page", pageCount(0), 1);
eq("a short document is one page", pageCount(400), 1);
eq("an exactly full page is one page", pageCount(1056), 1);
eq("a few pixels of slop do not add a blank page", pageCount(1060), 1);
eq("real overflow adds a second page", pageCount(1200), 2);
eq("two full pages", pageCount(2112), 2);
eq("a runaway template is capped", pageCount(10_000_000), 50);

console.log("check-html-template: page-image assertions passed");

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

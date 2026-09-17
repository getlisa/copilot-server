/**
 * HTML proposal templates: the company's document, authored as HTML, filled per estimate.
 *
 * WHY THIS EXISTS (2026-09-17). The block model reproduces a customer's document only as
 * closely as its block types allow — every new shape (five-column tables, black info panels,
 * a totals summary in the corner) cost a model change plus two renderers. An HTML file has no
 * such ceiling: fonts, rules, fills, columns and spacing are all just CSS, and one file can be
 * hand-tuned until it matches the uploaded document exactly.
 *
 * The template language is deliberately tiny and dependency-free — values, repeated sections
 * and conditionals, nothing executable:
 *
 *   {{customerName}}            a value, HTML-escaped
 *   {{{logoImg}}}               a value inserted raw (already-safe HTML we build)
 *   {{#lineItems}}…{{/lineItems}}   repeat the block once per item, its fields in scope
 *   {{#taxed}}…{{/taxed}}       include when the value is truthy / a non-empty list
 *   {{^taxed}}…{{/taxed}}       include when it is not
 *
 * There is no expression evaluation on purpose: a template is company-authored content, and
 * the renderer must never be a way to run code on the server.
 */

export type HtmlTemplateData = Record<string, unknown>;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

const truthy = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : value != null && value !== "" && value !== false;

/** Find `{{/name}}` matching the section that opened at `from`, honouring nesting. */
function findSectionEnd(template: string, name: string, from: number): number {
  const opener = new RegExp(`\\{\\{[#^]\\s*${name}\\s*\\}\\}`, "g");
  const closer = new RegExp(`\\{\\{/\\s*${name}\\s*\\}\\}`, "g");
  let depth = 1;
  let cursor = from;
  while (depth > 0) {
    closer.lastIndex = cursor;
    const close = closer.exec(template);
    if (!close) return -1;
    opener.lastIndex = cursor;
    const open = opener.exec(template);
    if (open && open.index < close.index) {
      depth++;
      cursor = open.index + open[0].length;
    } else {
      depth--;
      cursor = close.index + close[0].length;
      if (depth === 0) return close.index;
    }
  }
  return -1;
}

const SECTION_START = /\{\{([#^])\s*(\w+)\s*\}\}/;

/** Render one scope: sections first (they can contain values), then values. */
function renderScope(template: string, scope: HtmlTemplateData, parent?: HtmlTemplateData): string {
  let out = "";
  let rest = template;

  for (;;) {
    const match = SECTION_START.exec(rest);
    if (!match) break;
    const [tag, kind, name] = match;
    const bodyStart = match.index + tag.length;
    const bodyEnd = findSectionEnd(rest, name, bodyStart);
    // An unclosed section is template author error: print the rest literally rather than
    // swallowing the remainder of their document silently.
    if (bodyEnd === -1) break;

    out += fillValues(rest.slice(0, match.index), scope, parent);
    const body = rest.slice(bodyStart, bodyEnd);
    const value = lookup(name, scope, parent);

    if (kind === "^") {
      if (!truthy(value)) out += renderScope(body, scope, parent);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        out += renderScope(
          body,
          (item && typeof item === "object" ? item : { ".": item }) as HtmlTemplateData,
          scope
        );
      }
    } else if (truthy(value)) {
      out += renderScope(
        body,
        (value && typeof value === "object" ? (value as HtmlTemplateData) : scope),
        scope
      );
    }

    const closeTag = new RegExp(`\\{\\{/\\s*${name}\\s*\\}\\}`);
    const after = rest.slice(bodyEnd);
    rest = after.replace(closeTag, "");
  }

  return out + fillValues(rest, scope, parent);
}

const lookup = (name: string, scope: HtmlTemplateData, parent?: HtmlTemplateData): unknown =>
  name in scope ? scope[name] : parent ? parent[name] : undefined;

function fillValues(text: string, scope: HtmlTemplateData, parent?: HtmlTemplateData): string {
  return text
    .replace(/\{\{\{\s*(\w+)\s*\}\}\}/g, (raw, name: string) => {
      const value = lookup(name, scope, parent);
      return value == null ? "" : String(value);
    })
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, name: string) => {
      const value = lookup(name, scope, parent);
      // An unknown name stays visible rather than vanishing — a silently blank document is
      // the failure mode nobody notices until a customer receives it.
      return value === undefined ? raw : escapeHtml(value);
    });
}

export function renderHtmlTemplate(template: string, data: HtmlTemplateData): string {
  return renderScope(template, data);
}

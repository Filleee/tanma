import type { GlossaryNode, SCNode, SCElement } from "../../lib/yomitan/types";
import { el } from "./dom";

// Renders Yomitan glossary entries (plain strings or "structured-content" trees,
// as used by Jitendex) into safe DOM. Unknown/unsafe tags degrade to <span>.

const ALLOWED = new Set([
  "span", "div", "p", "br", "ul", "ol", "li", "ruby", "rt", "rp",
  "a", "b", "i", "em", "strong", "sub", "sup", "small", "table", "thead",
  "tbody", "tr", "td", "th", "details", "summary",
]);

const SAFE_STYLE = new Set([
  "fontStyle", "fontWeight", "textDecorationLine", "textDecoration", "fontSize",
  "color", "marginLeft", "marginTop", "marginBottom", "listStyleType",
  "verticalAlign", "textAlign", "whiteSpace",
]);

/** Resolves a dictionary-bundled media path to a data: URL (or null). */
export type MediaResolver = (path: string) => Promise<string | null>;

/** Render one term's glossary array as a numbered list of definitions. */
export function renderGlossary(nodes: GlossaryNode[], media?: MediaResolver): HTMLElement {
  const ol = el("ol", { class: "tnm-gloss" });
  for (const node of nodes) {
    const li = el("li");
    li.append(renderGlossaryNode(node, media));
    ol.append(li);
  }
  return ol;
}

function renderGlossaryNode(node: GlossaryNode, media?: MediaResolver): Node {
  if (typeof node === "string") return document.createTextNode(node);
  const obj = node as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") return document.createTextNode(obj.text);
  if (obj.type === "structured-content") return renderSC(obj.content as SCNode, media);
  if (obj.type === "image") return el("span", { class: "tnm-gloss__img" }, "🖼");
  // Unknown object shape — best-effort stringify
  return document.createTextNode(typeof obj === "object" ? JSON.stringify(obj) : String(obj));
}

function renderSC(node: SCNode, media?: MediaResolver): Node {
  if (node == null) return document.createTextNode("");
  if (typeof node === "string") return document.createTextNode(node);
  if (Array.isArray(node)) {
    const frag = document.createDocumentFragment();
    for (const child of node) frag.append(renderSC(child, media));
    return frag;
  }
  const elem = node as SCElement;
  // Dictionary-bundled images (e.g. pitch graphs, diagrams): filled lazily from the
  // extension's media store; degrades to the alt text when the media isn't available.
  if (elem.tag === "img" && typeof (elem as Record<string, unknown>).path === "string") {
    const raw = elem as Record<string, unknown>;
    const img = document.createElement("img");
    img.className = "tnm-gloss__media";
    if (typeof raw.title === "string") img.alt = raw.title;
    if (typeof raw.width === "number") img.style.width = `${raw.width}em`;
    if (typeof raw.height === "number") img.style.maxHeight = `${raw.height}em`;
    img.style.display = "none"; // until (unless) the media resolves
    media?.(raw.path as string).then((url) => {
      if (url) {
        img.src = url;
        img.style.display = "";
      }
    }).catch(() => {});
    return img;
  }
  const tag = ALLOWED.has(elem.tag) ? elem.tag : "span";
  const node2 = document.createElement(tag);

  if (tag === "a" && typeof elem.href === "string") {
    // Only allow safe external/anchor links.
    if (/^https?:|^#/.test(elem.href)) {
      (node2 as HTMLAnchorElement).href = elem.href;
      node2.setAttribute("target", "_blank");
      node2.setAttribute("rel", "noopener noreferrer");
    }
  }
  if (typeof elem.lang === "string") node2.setAttribute("lang", elem.lang);
  if (elem.data && typeof elem.data === "object") {
    for (const [k, v] of Object.entries(elem.data)) node2.setAttribute(`data-${k}`, String(v));
  }
  if (elem.style && typeof elem.style === "object") {
    for (const [k, v] of Object.entries(elem.style)) {
      if (SAFE_STYLE.has(k)) (node2.style as any)[k] = typeof v === "number" ? `${v}em` : String(v);
    }
  }
  if (elem.content != null) node2.append(renderSC(elem.content, media));
  return node2;
}

/** Minimal HTML-escape for text inserted into a field (e.g. dict titles). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}
function escapeAttr(s: string): string {
  return s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

/**
 * Build a Yomitan-shaped glossary: `<div class="yomitan-glossary"><ol>` with one
 * `<li data-dictionary="NAME"><i>(tags, NAME)</i>…content…</li>` per entry. The
 * lapis card template parses dictionaries via `li[data-dictionary]`, so matching
 * this lets it de-duplicate the primary from the glossary and read pitch.
 */
export function yomitanGlossary(sections: import("../../common/types").DictSection[]): string {
  const items = sections.flatMap((sec) =>
    sec.entries.map((e) => {
      const tags = e.tags?.length ? e.tags.join(", ") + ", " : "";
      return `<li data-dictionary="${escapeAttr(sec.dictTitle)}"><i>(${escapeHtml(tags + sec.dictTitle)})</i>${renderGlossary(e.glossary).outerHTML}</li>`;
    }),
  );
  if (!items.length) return "";
  return `<div class="yomitan-glossary" style="text-align:left"><ol>${items.join("")}</ol></div>`;
}

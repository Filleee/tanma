// Tiny DOM helpers — keeps component code declarative without a framework.

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (typeof v === "boolean") {
      if (v) node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/** Build an SVG node from a raw inner markup string (for icons). */
export function svg(inner: string, viewBox = "0 0 24 24"): SVGSVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", viewBox);
  s.setAttribute("fill", "none");
  s.innerHTML = inner;
  return s;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

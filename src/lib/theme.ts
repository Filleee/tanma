// Tiny accent-colour helpers shared by every surface (overlay, dashboard, popup, player).

/** Preset accent swatches offered in the dashboard. */
export const ACCENTS: { hex: string; name: string }[] = [
  { hex: "#ff9345", name: "Orange" },
  { hex: "#4aa3ff", name: "Blue" },
  { hex: "#36c275", name: "Green" },
  { hex: "#b07cff", name: "Purple" },
  { hex: "#ff6fae", name: "Pink" },
  { hex: "#2dd4bf", name: "Teal" },
  { hex: "#ff6b6b", name: "Red" },
];

/** Darken a #rrggbb hex by `amt` (0..1) — used for the pressed/hover accent shade. */
export function darken(hex: string, amt = 0.18): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * (1 - amt)))));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Set the accent CSS variables on a root element. The overlay uses `--tnm-accent`; the
 *  dashboard/popup/player use `--accent`. */
export function applyAccentVars(root: HTMLElement, hex: string, prefix = "--accent"): void {
  const c = /^#[0-9a-f]{6}$/i.test(hex.trim()) ? hex.trim() : "#ff9345";
  root.style.setProperty(prefix, c);
  root.style.setProperty(`${prefix}-700`, darken(c, 0.18));
}

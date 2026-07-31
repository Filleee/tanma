// Tiny semver-ish comparison for the "update available" check: is the latest GitHub release
// newer than the installed manifest version? Tags may carry a leading "v" and/or a "-prerelease"
// suffix; we compare the numeric core (major.minor.patch…).

/** ["v0.2.0" | "0.2.0" | "0.2.0-beta"] → [0, 2, 0]. */
export function versionParts(v: string): number[] {
  const core = String(v || "").trim().replace(/^v/i, "").split(/[-+]/)[0];
  return core.split(".").map((n) => parseInt(n, 10) || 0);
}

/** True when `latest` is strictly newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

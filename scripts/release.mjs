// Local release builder — the same steps as the CI workflow, for when you'd rather not use
// GitHub Actions (or your account's Actions are unavailable). Builds the extension, stamps the
// manifest version to match the tag, and zips it into dist.zip (wrapped in a top-level dist/
// folder). Then draft a GitHub Release, tag it, and drag in dist.zip.
//
//   node scripts/release.mjs v0.1.0
//
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tag = process.argv[2];
if (!tag) {
  console.error("usage: node scripts/release.mjs v0.1.0");
  process.exit(1);
}
const num = tag.replace(/^v/i, ""); // manifest version (no leading v)
if (!/^\d+(\.\d+){0,3}$/.test(num)) {
  console.error(`"${tag}" → "${num}" isn't a valid extension version (need e.g. v0.2.0).`);
  process.exit(1);
}

console.log(`\n▶ Building extension…`);
execSync("npm run build", { stdio: "inherit", cwd: root });

const manifestPath = join(root, "dist", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = num;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`▶ Stamped manifest.version → ${num}`);

// Walk dist/ into an fflate file map keyed "dist/<path>" so the zip has a top-level dist/ folder.
const distDir = join(root, "dist");
const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[`dist/${relative(distDir, p).replace(/\\/g, "/")}`] = new Uint8Array(readFileSync(p));
  }
};
walk(distDir);
const zip = zipSync(files, { level: 6 });
const outPath = join(root, "dist.zip");
writeFileSync(outPath, zip);

const kb = (zip.length / 1024).toFixed(0);
console.log(`\n✓ dist.zip ready — ${Object.keys(files).length} files, ${kb} KB, version ${num}`);
console.log(`  ${outPath}`);
console.log(`\nNext: GitHub → Releases → Draft a new release → tag "${tag}" → drag in dist.zip → Publish.`);

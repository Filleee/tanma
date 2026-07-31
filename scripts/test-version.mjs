// Unit test for the update-check version comparison. Run: node scripts/test-version.mjs
import * as esbuild from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(await mkdtemp(join(tmpdir(), "tnm-ver-")), "version.mjs");
await esbuild.build({ entryPoints: [resolve(root, "src/lib/version.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const { isNewerVersion, versionParts } = await import(pathToFileURL(out).href);

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? "OK " : "XX "} ${name}`); if (!ok) failures++; };

check("v0.2.0 > 0.1.0", isNewerVersion("v0.2.0", "0.1.0") === true);
check("0.2.0 > v0.1.9", isNewerVersion("0.2.0", "v0.1.9") === true);
check("v1.0.0 > 0.9.9", isNewerVersion("v1.0.0", "0.9.9") === true);
check("equal is not newer", isNewerVersion("0.1.0", "0.1.0") === false);
check("older is not newer", isNewerVersion("v0.1.0", "0.2.0") === false);
check("patch bump", isNewerVersion("0.1.1", "0.1.0") === true);
check("prerelease core compared", isNewerVersion("v0.2.0-beta", "0.1.0") === true);
check("missing parts treated as 0 (0.2 > 0.1.9)", isNewerVersion("0.2", "0.1.9") === true);
check("parts parse", JSON.stringify(versionParts("v1.2.3-rc1")) === JSON.stringify([1, 2, 3]));

console.log(failures === 0 ? "\nVERSION COMPARE: ALL PASSING" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

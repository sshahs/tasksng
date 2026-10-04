// Builds latest.json, the manifest the in-app updater reads from
// https://github.com/<repo>/releases/latest/download/latest.json
//
// usage: node scripts/updater-manifest.mjs <dir with installers + .sig files>
// env:   GITHUB_REPOSITORY, GITHUB_REF_NAME (the release tag)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "out";
const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
if (!repo || !tag) throw new Error("GITHUB_REPOSITORY and GITHUB_REF_NAME must be set");

const files = readdirSync(dir);
const entry = (suffix) => {
  const file = files.find((f) => f.endsWith(suffix));
  if (!file) throw new Error(`no *${suffix} in ${dir}`);
  const sig = join(dir, `${file}.sig`);
  return {
    signature: readFileSync(sig, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
  };
};

const nsis = entry("-setup.exe");
const msi = entry(".msi");
const manifest = {
  version: tag.replace(/^v/, ""),
  notes: `https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms: {
    // The updater looks for "{os}-{arch}-{installer}" first, then "{os}-{arch}".
    "windows-x86_64": nsis,
    "windows-x86_64-nsis": nsis,
    "windows-x86_64-msi": msi,
  },
};
writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`latest.json for ${manifest.version}:`, Object.keys(manifest.platforms).join(", "));

// Builds latest.json, the manifest the in-app updater reads (see
// plugins.updater.endpoints in src-tauri/tauri.conf.json).
//
// usage: node scripts/updater-manifest.mjs <dir with installers + .sig files>
// env:   RELEASE_TAG (e.g. v0.2.0), and either RELEASE_DOWNLOAD_BASE (the
//        URL release files are downloaded from, without the tag) or
//        GITHUB_REPOSITORY (owner/name on GitHub).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "out";
const tag = process.env.RELEASE_TAG;
const repo = process.env.GITHUB_REPOSITORY;
const base = (process.env.RELEASE_DOWNLOAD_BASE || (repo ? `https://github.com/${repo}/releases/download` : "")).replace(/\/+$/, "");
if (!base || !tag) throw new Error("RELEASE_TAG and RELEASE_DOWNLOAD_BASE (or GITHUB_REPOSITORY) must be set");

const files = readdirSync(dir);
const entry = (suffix, required = true) => {
  const file = files.find((f) => f.endsWith(suffix));
  if (!file) {
    if (required) throw new Error(`no *${suffix} in ${dir}`);
    return null;
  }
  return {
    signature: readFileSync(join(dir, `${file}.sig`), "utf8").trim(),
    url: `${base}/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
  };
};

const nsis = entry("-setup.exe");
// The MSI is built on Windows only (WiX); cross-built releases have none.
const msi = entry(".msi", false);
const platforms = {
  // The updater looks for "{os}-{arch}-{installer}" first, then "{os}-{arch}".
  "windows-x86_64": nsis,
  "windows-x86_64-nsis": nsis,
};
if (msi) platforms["windows-x86_64-msi"] = msi;
const manifest = {
  version: tag.replace(/^v/, ""),
  notes: base.replace(/\/download$/, `/tag/${tag}`),
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`latest.json for ${manifest.version}:`, Object.keys(platforms).join(", "));

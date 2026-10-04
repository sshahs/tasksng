// Writes src-tauri/tauri.ci.conf.json, a config overlay for CI builds.
// On a release tag (vX.Y.Z) it stamps the version and turns on signed updater
// artifacts, which requires the TAURI_SIGNING_PRIVATE_KEY secret.
import { writeFileSync } from "node:fs";

const ref = process.env.GITHUB_REF ?? "";
const overlay = {};

if (ref.startsWith("refs/tags/v")) {
  const version = ref.slice("refs/tags/v".length);
  // MSI only accepts numeric versions, so no pre-release suffixes.
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`::error::Tag v${version} must look like vX.Y.Z`);
    process.exit(1);
  }
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    console.error(
      "::error::Releases must be signed for auto-update. Add the TAURI_SIGNING_PRIVATE_KEY secret " +
        "(Settings → Secrets and variables → Actions). See README → Releases.",
    );
    process.exit(1);
  }
  overlay.version = version;
  overlay.bundle = { createUpdaterArtifacts: true };
  console.log(`Release build ${version} with signed updater artifacts`);
} else {
  console.log("Development build (no updater artifacts)");
}

writeFileSync("src-tauri/tauri.ci.conf.json", JSON.stringify(overlay, null, 2) + "\n");

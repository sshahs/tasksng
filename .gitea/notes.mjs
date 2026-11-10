// Prints the body of a release: docs/release-notes/<version>.md and how to
// install each part. Used by the Gitea workflows.
//
//   node .gitea/notes.mjs <version>
import { readFileSync } from "node:fs";

const version = process.argv[2];
const server = (process.env.GITEA_URL ?? "").replace(/\/+$/, "");
const repo = process.env.GITEA_REPO ?? "";
const host = server.replace(/^https?:\/\//, "");
const image = `${host}/${repo.toLowerCase()}`;
let notes = "";
try {
  notes = readFileSync(`docs/release-notes/${version}.md`, "utf8").trim();
} catch {
  // No notes written for this version.
}

const cert = process.env.SIGNING_CERT_SHA256;
console.log(`${notes ? notes + "\n\n" : ""}## Install

| | |
| --- | --- |
| **Android** | \`TasksNG_${version}_android.apk\`: open it on your phone (Android 8 or later). Updates install over it.${cert ? `<br>Signing certificate SHA-256: \`${cert}\`` : ""} |
| **Windows** | \`TasksNG_${version}_x64-setup.exe\` (per-user installer, updates itself) or \`TasksNG-portable.exe\` |
| **Web app (Docker)** | \`docker pull ${image}:${version}\` — see *Self-hosting with Docker* in the README |
| **NixOS / Nix** | \`nix run git+${server}/${repo}?ref=refs/tags/v${version}\` |

Checksums are in the \`SHA256SUMS-*.txt\` files.`);

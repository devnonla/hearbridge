/**
 * Write release/latest.json for the in-app updater from the signed archive
 * (scripts/build-app.ts --archive) and this version's CHANGELOG section, plus
 * release/notes.md for the GitHub release body.
 *
 *   GITHUB_REPOSITORY=devnonla/hearbridge bun scripts/updater-manifest.ts
 *
 * The app reads https://github.com/<repo>/releases/latest/download/latest.json
 * (tauri.conf.json → plugins.updater.endpoints), so the release must be
 * published (not a draft, not a pre-release) for users to get it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changelogSection, packageVersion } from "./version";

const root = join(import.meta.dir, "..");
const out = join(root, "release");
const repo = process.env.GITHUB_REPOSITORY?.trim() || "devnonla/hearbridge";
const version = packageVersion();
const section = changelogSection(version);

// Plain text for the in-app banner.
const notes = section
  .replace(/^#+\s*/gm, "")
  .replace(/\*\*(.+?)\*\*/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  .replace(/^- /gm, "• ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const files = existsSync(out) ? readdirSync(out) : [];
const dmg = files.find((f) => f.endsWith(".dmg"));

// GitHub release body: CHANGELOG section + install notes.
const body = `${section || "_No notes in CHANGELOG.md for this version._"}

## Install

Download ${dmg ? `\`${dmg}\`` : "the `.dmg`"} below, open it and drag **HearBridge** to **Applications**. Requires macOS 14.4+ on Apple Silicon.

If macOS says the app is damaged or can't be opened (the app is not notarized), run once:

\`\`\`bash
xattr -cr /Applications/HearBridge.app
\`\`\`

Already installed? HearBridge offers this update in the app.

Full changelog: [CHANGELOG.md](https://github.com/${repo}/blob/main/CHANGELOG.md)
`;
writeFileSync(join(out, "notes.md"), body);
console.log("Wrote release/notes.md");

const archive = files.find((f) => f.endsWith(".app.tar.gz"));
if (!archive || !existsSync(join(out, `${archive}.sig`))) {
  const message = "No signed .app.tar.gz(.sig) in release/. Build with TAURI_SIGNING_PRIVATE_KEY set.";
  // With the key configured a missing signature is a broken build; without it, just skip latest.json.
  if (process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error(message);
  console.warn(`${message} Skipping latest.json: installed apps will not see this release.`);
  process.exit(0);
}
const signature = readFileSync(join(out, `${archive}.sig`), "utf8").trim();
const url = `https://github.com/${repo}/releases/download/v${version}/${archive}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": { signature, url },
  },
};
writeFileSync(join(out, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote release/latest.json for ${version} → ${url}`);

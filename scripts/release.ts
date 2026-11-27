/**
 * Cut a release: bump the version, roll CHANGELOG.md, commit and tag.
 * Pushing the tag starts .github/workflows/release.yml, which builds, signs and
 * publishes the GitHub release with latest.json for the in-app updater.
 *
 *   bun run release patch|minor|major|<x.y.z[-beta.N]> [--push] [--allow-branch]
 *
 * Without --push it stops after tagging and prints the push command.
 */
import { $ } from "bun";
import { join } from "node:path";
import { bump, changelogSection } from "./version";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const kind = args.find((a) => !a.startsWith("--"));
const push = args.includes("--push");
const allowBranch = args.includes("--allow-branch");

const fail = (text: string): never => {
  console.error(`error: ${text}`);
  process.exit(1);
};

if (!kind) fail("Usage: bun run release patch|minor|major|<x.y.z> [--push]");

$.cwd(root);

const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "main" && !allowBranch) fail(`Releases are cut from main (on ${branch}). Pass --allow-branch to override.`);
if ((await $`git status --porcelain`.text()).trim()) fail("Working tree is not clean. Commit or stash first.");
if (!changelogSection("Unreleased")) {
  fail("CHANGELOG.md has nothing under ## [Unreleased]. Add the release notes there first.");
}

const { previous, version } = bump(kind as string);
const tag = `v${version}`;
console.log(`\n${previous} → ${version}`);

try {
  if ((await $`git tag --list ${tag}`.text()).trim()) throw new Error(`Tag ${tag} already exists.`);
  console.log("\nChecking the build (tsc + vite, cargo check)…");
  await $`bun run build`;
  await $`cargo check --manifest-path src-tauri/Cargo.toml`;
} catch (err) {
  await $`git checkout -- package.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md`.nothrow();
  fail(`${(err as Error).message}\nVersion bump reverted.`);
}

await $`git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md`;
await $`git commit -m ${`chore: release ${tag}`}`;
await $`git tag -a ${tag} -m ${`HearBridge ${tag}`}`;
console.log(`\nCommitted and tagged ${tag}.`);

if (push) {
  await $`git push origin ${branch}`;
  await $`git push origin ${tag}`;
  console.log(`Pushed. Watch the build: https://github.com/devnonla/hearbridge/actions/workflows/release.yml`);
} else {
  console.log(`Push to publish:\n  git push origin ${branch} && git push origin ${tag}`);
}

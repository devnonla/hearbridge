/**
 * Version bookkeeping. package.json is the source of truth: tauri.conf.json reads
 * it (`"version": "../package.json"`), Cargo.toml / Cargo.lock are kept in step.
 *
 *   bun scripts/version.ts patch|minor|major|<x.y.z[-pre.N]>   bump + roll CHANGELOG
 *   bun scripts/version.ts --check [--tag v1.2.3]              versions agree (CI)
 *   bun scripts/version.ts --notes [version]                   print a CHANGELOG section
 *
 * Bumping moves the `## [Unreleased]` notes under `## [x.y.z] - <today>` and
 * updates the compare links at the bottom of CHANGELOG.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const REPO_URL = "https://github.com/devnonla/hearbridge";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;

const paths = {
  pkg: join(root, "package.json"),
  cargo: join(root, "src-tauri", "Cargo.toml"),
  lock: join(root, "src-tauri", "Cargo.lock"),
  changelog: join(root, "CHANGELOG.md"),
};

const read = (path: string) => readFileSync(path, "utf8");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function packageVersion(): string {
  return (JSON.parse(read(paths.pkg)) as { version: string }).version;
}

export function cargoVersion(): string | undefined {
  return /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(read(paths.cargo))?.[1];
}

/** The body of `## [version]` in CHANGELOG.md (without the heading), or "". */
export function changelogSection(version: string): string {
  const match = new RegExp(
    `^## \\[${escape(version)}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[[^\\]]+\\]:|(?![\\s\\S]))`,
    "m",
  ).exec(read(paths.changelog));
  return (match?.[1] ?? "").trim();
}

export function nextVersion(current: string, bump: string): string {
  if (SEMVER.test(bump)) return bump;
  const [major, minor, patch] = current.replace(/-.*/, "").split(".").map(Number);
  const isPre = current.includes("-");
  switch (bump) {
    // 1.2.3-beta.1 → patch → 1.2.3 (finish the pre-release)
    case "patch":
      return isPre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`Unknown bump "${bump}". Use patch, minor, major or an explicit x.y.z version.`);
  }
}

function writeVersions(version: string) {
  const pkg = read(paths.pkg).replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  writeFileSync(paths.pkg, pkg);

  const cargo = read(paths.cargo).replace(/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
  writeFileSync(paths.cargo, cargo);

  const lock = read(paths.lock).replace(/(\[\[package\]\]\nname = "hearbridge"\nversion = ")[^"]+(")/, `$1${version}$2`);
  writeFileSync(paths.lock, lock);
}

function rollChangelog(previous: string, version: string, date = new Date().toISOString().slice(0, 10)) {
  let text = read(paths.changelog);
  if (new RegExp(`^## \\[${escape(version)}\\]`, "m").test(text)) {
    console.log(`CHANGELOG.md already has a ${version} section; leaving it as is.`);
    return;
  }
  if (!/^## \[Unreleased\]/m.test(text)) throw new Error("CHANGELOG.md has no ## [Unreleased] section.");
  text = text.replace(/^## \[Unreleased\][^\n]*\n/m, `## [Unreleased]\n\n## [${version}] - ${date}\n`);

  const unreleasedLink = `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD`;
  const versionLink = `[${version}]: ${REPO_URL}/compare/v${previous}...v${version}`;
  if (/^\[Unreleased\]:.*$/m.test(text)) {
    text = text.replace(/^\[Unreleased\]:.*$/m, `${unreleasedLink}\n${versionLink}`);
  } else {
    text = `${text.trimEnd()}\n\n${unreleasedLink}\n${versionLink}\n`;
  }
  writeFileSync(paths.changelog, text);
}

export function bump(kind: string): { previous: string; version: string } {
  const previous = packageVersion();
  const version = nextVersion(previous, kind);
  if (!SEMVER.test(version)) throw new Error(`Invalid version "${version}".`);
  if (version === previous) throw new Error(`Already at ${version}.`);
  writeVersions(version);
  rollChangelog(previous, version);
  return { previous, version };
}

/** Throws when package.json, Cargo.toml (and the tag, when given) disagree. */
export function check(tag?: string) {
  const version = packageVersion();
  const problems: string[] = [];
  if (!SEMVER.test(version)) problems.push(`package.json version "${version}" is not semver`);
  const cargo = cargoVersion();
  if (cargo !== version) problems.push(`src-tauri/Cargo.toml is ${cargo}, package.json is ${version}`);
  if (tag) {
    const clean = tag.replace(/^refs\/tags\//, "");
    if (clean !== `v${version}`) problems.push(`tag ${clean} does not match package.json version v${version}`);
    if (!changelogSection(version)) problems.push(`CHANGELOG.md has no notes under ## [${version}]`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(`Version ${version} is consistent${tag ? ` with ${tag}` : ""}.`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--check") {
      const i = args.indexOf("--tag");
      check(i >= 0 ? args[i + 1] : undefined);
    } else if (args[0] === "--notes") {
      console.log(changelogSection(args[1] ?? packageVersion()));
    } else if (args[0] && !args[0].startsWith("-")) {
      const { previous, version } = bump(args[0]);
      console.log(`${previous} → ${version} (package.json, Cargo.toml, Cargo.lock, CHANGELOG.md)`);
    } else {
      console.log("Usage: bun scripts/version.ts patch|minor|major|<x.y.z> | --check [--tag vX.Y.Z] | --notes [version]");
      process.exit(args.length ? 1 : 0);
    }
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

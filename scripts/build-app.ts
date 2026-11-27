/**
 * Build the release app + DMG (Apple Silicon). With the updater key set, Tauri
 * also writes the signed update archive used by the in-app updater.
 *
 *   bun scripts/build-app.ts [--target aarch64-apple-darwin] [--debug] [--archive]
 *
 * Env (all optional; empty values are ignored so CI can pass unset secrets):
 *   TAURI_SIGNING_PRIVATE_KEY           updater key: its content or a path (~/.tauri/hearbridge-updater.key)
 *   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password
 *   APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY
 *                                       Developer ID signing (default: ad-hoc "-")
 *   APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID  or  APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH
 *                                       notarization (needs Developer ID signing)
 *
 * The updater's public key and endpoint live in src-tauri/tauri.conf.json
 * (`plugins.updater`); `createUpdaterArtifacts` is turned on here only when the
 * private key is present, so contributors can build without it.
 *
 * --archive collects the release files in release/:
 *   HearBridge_<version>_aarch64.dmg
 *   HearBridge_<version>_aarch64.app.tar.gz (+ .sig when signed) for scripts/updater-manifest.ts
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { packageVersion } from "./version";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const target = option("--target") ?? "aarch64-apple-darwin";
const arch = target.startsWith("aarch64") ? "aarch64" : target.startsWith("x86_64") ? "x64" : "universal";
const profile = flag("--debug") ? "debug" : "release";
const version = packageVersion();
const productName = "HearBridge";

// Drop empty variables: GitHub passes unset secrets as "", which Tauri would try to use.
const OPTIONAL = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
];
const env: Record<string, string | undefined> = { ...process.env };
for (const name of OPTIONAL) {
  const value = env[name]?.trim();
  if (value) env[name] = value.replace(/^~(?=\/)/, homedir());
  else delete env[name];
}

const signed = Boolean(env.TAURI_SIGNING_PRIVATE_KEY);
if (signed && env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
  // A key without a password still needs the variable set, or Tauri prompts for it.
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
}
console.log(
  signed
    ? "Updater archive: signed (TAURI_SIGNING_PRIVATE_KEY is set)."
    : "Updater archive: off. Set TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) to sign it.",
);
console.log(
  env.APPLE_SIGNING_IDENTITY
    ? `Code signing: ${env.APPLE_SIGNING_IDENTITY}${env.APPLE_ID || env.APPLE_API_KEY ? " + notarization" : ""}`
    : "Code signing: ad-hoc (not notarized).",
);

const tauriArgs = [
  "--target",
  target,
  "--bundles",
  "app,dmg",
  ...(flag("--debug") ? ["--debug"] : []),
  ...(signed ? ["--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true } })] : []),
];
await $`bunx tauri build ${tauriArgs}`.cwd(root).env(env);

const bundle = join(root, "src-tauri", "target", target, profile, "bundle");
console.log(`\nApp ready in ${bundle}`);

if (flag("--archive")) {
  const out = join(root, "release");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const base = `${productName}_${version}_${arch}`;
  const archive = join(out, `${base}.app.tar.gz`);

  const tauriArchive = join(bundle, "macos", `${productName}.app.tar.gz`);
  if (signed) {
    if (!existsSync(tauriArchive) || !existsSync(`${tauriArchive}.sig`)) {
      throw new Error(`Tauri did not produce the signed update archive ${tauriArchive}(.sig).`);
    }
    copyFileSync(tauriArchive, archive);
    copyFileSync(`${tauriArchive}.sig`, `${archive}.sig`);
  } else {
    await $`tar -czf ${archive} -C ${join(bundle, "macos")} ${`${productName}.app`}`;
  }

  const dmg = readdirSync(join(bundle, "dmg")).find((f) => f.endsWith(".dmg"));
  if (!dmg) throw new Error(`No DMG in ${join(bundle, "dmg")}`);
  copyFileSync(join(bundle, "dmg", dmg), join(out, `${base}.dmg`));
  console.log(`Release files in ${out}:`);
  for (const file of readdirSync(out)) console.log(`  ${file}`);
}

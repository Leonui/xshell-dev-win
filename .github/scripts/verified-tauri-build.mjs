import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tauriManifest = join(repoRoot, "src-tauri", "Cargo.toml");
const verifier = "verify_updater_signature";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) fail(`Failed to run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function collectFiles(directory, predicate, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(path, predicate, files);
    else if (predicate(path)) files.push(path);
  }
  return files;
}

function configuredPublicKey() {
  const config = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const key = config?.plugins?.updater?.pubkey;
  if (typeof key !== "string" || key.trim() === "") fail("tauri.conf.json has no updater public key");
  return key;
}

function verifySignatures(releaseRoot) {
  if (!existsSync(releaseRoot)) fail(`Tauri release output does not exist: ${releaseRoot}`);
  const signatures = collectFiles(releaseRoot, path => path.endsWith(".sig"));
  if (signatures.length === 0) fail(`No updater signatures were generated under ${releaseRoot}`);

  if (process.platform === "win32") {
    for (const bundle of ["msi", "nsis"]) {
      const bundleRoot = join(releaseRoot, "bundle", bundle);
      if (!existsSync(bundleRoot) || !collectFiles(bundleRoot, path => path.endsWith(".sig")).length) {
        fail(`The Windows ${bundle} updater signature is missing`);
      }
    }
  }

  const publicKey = configuredPublicKey();
  for (const signature of signatures) {
    const artifact = signature.slice(0, -4);
    if (!existsSync(artifact)) fail(`Signature has no paired artifact: ${signature}`);
    run("cargo", [
      "run", "--quiet", "--manifest-path", tauriManifest,
      "--example", verifier, "--", publicKey, artifact, signature,
    ]);
  }
  console.log(`Cryptographically verified ${signatures.length} updater signature(s).`);
}

function targetFromArgs(args) {
  const index = args.indexOf("--target");
  if (index >= 0) return args[index + 1];
  return args.find(argument => argument.startsWith("--target="))?.slice("--target=".length);
}

const args = process.argv.slice(2);
if (args[0] === "verify-only") {
  verifySignatures(resolve(repoRoot, args[1] ?? join("src-tauri", "target", "release")));
  process.exit(0);
}
if (args[0] !== "build") fail("verified-tauri-build only supports the Tauri build command");

run(process.execPath, [join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...args]);
const target = targetFromArgs(args);
const profile = args.includes("--debug") ? "debug" : "release";
const releaseRoot = target
  ? join(repoRoot, "src-tauri", "target", target, profile)
  : join(repoRoot, "src-tauri", "target", profile);
verifySignatures(releaseRoot);

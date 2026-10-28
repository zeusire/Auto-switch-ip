#!/usr/bin/env node
/**
 * Fetch the two external binaries the engine drives, for the host we are on.
 *
 *   node autoswitchip/fetch-binaries.mjs           # missing only
 *   node autoswitchip/fetch-binaries.mjs --force   # re-download everything
 *   BIN_MIRROR=https://mirror.example node ...     # when GitHub releases are blocked
 *   ASIP_BIN_DIR=/app/data/autoswitchip/bin node ...
 *
 * Neither binary is committed: sing-box is 55 MB and usque ships per-platform
 * archives, so the repo would carry a tarball of binaries it never uses on the
 * other platform. Checksums are the release digests GitHub publishes per
 * asset; a mismatch refuses to install. Both a .tar.gz and a .zip extractor
 * are implemented in-process — `tar` on Windows is bsdtar and cannot always
 * read zip, and a missing unzip must not leave a half-provisioned engine.
 *
 * Also importable: `provision()` is what the dashboard's enable step calls
 * before spawning the daemon, so a first-time user never has to run a script.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIRROR = process.env.BIN_MIRROR || "https://github.com";

const SING_BOX_VERSION = "1.13.0";
const USQUE_VERSION = "4.2.1";

// label -> { url, sha256 }
const ARTIFACTS = {
  "sing-box-linux-amd64": {
    url: `SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-amd64.tar.gz`,
    sha256: "86db0f9df3f822ca2adccde2f7c1c9e21d64e646a77bf258274fde3be399025b",
    archive: "tar.gz",
    binary: "sing-box",
  },
  "sing-box-linux-arm64": {
    url: `SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-arm64.tar.gz`,
    sha256: "57efdb8a256ae0736fa00aee5538c384ee50b40882075d2d1a05a1c3d7c4a889",
    archive: "tar.gz",
    binary: "sing-box",
  },
  "sing-box-windows-amd64": {
    url: `SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-windows-amd64.zip`,
    sha256: "c080ac4f53f1e92fe44a5440958bfe6ff6a3db75347fe6b31afc6d6517a8d76e",
    archive: "zip",
    binary: "sing-box.exe",
  },
  "usque-linux-amd64": {
    url: `Diniboy1123/usque/releases/download/v${USQUE_VERSION}/usque_${USQUE_VERSION}_linux_amd64.zip`,
    sha256: "4117e20695078af9c11edecd1a826c009bbc7ea0b7f64458612b4198910bc313",
    archive: "zip",
    binary: "usque",
  },
  "usque-linux-arm64": {
    url: `Diniboy1123/usque/releases/download/v${USQUE_VERSION}/usque_${USQUE_VERSION}_linux_arm64.zip`,
    sha256: "c88b061c2a567f30813d7505637d1fb6fe7ec5898b5b61fd05122409fa5ad925",
    archive: "zip",
    binary: "usque",
  },
  "usque-windows-amd64": {
    url: `Diniboy1123/usque/releases/download/v${USQUE_VERSION}/usque_${USQUE_VERSION}_windows_amd64.zip`,
    sha256: "f6f7f0a1a2bc9bcc15cf563ec1f892d00690a92c086b23ed3211b802209099e7",
    archive: "zip",
    binary: "usque.exe",
  },
};

/** Where the binaries land. The dashboard passes DATA_DIR's bin dir on hosts
 *  whose app directory is read-only (Railway), matching hostos.binary_search_paths. */
export function binDir() {
  const override = process.env.ASIP_BIN_DIR;
  if (override) return path.resolve(override);
  return path.join(HERE, "bin");
}

function hostArch() {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`unsupported architecture: ${process.arch}`);
}

function hostOs() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  throw new Error(
    `unsupported platform: ${process.platform}. The engine's tunnel binaries are ` +
      `published for linux and windows only.`,
  );
}

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------- extractors
//
// Both formats are parsed here instead of shelling out to `tar`/`unzip`.
// Windows' tar.exe (bsdtar) handles zip but not every Windows image ships it,
// and slim Linux images routinely omit unzip. A failure here leaves the engine
// half-provisioned, which is the worst state to debug from the dashboard.

/** Entries of a zip archive: { name, data } for stored and deflated files. */
function readZip(buffer) {
  // End-of-central-directory lives in the last 64 KiB + 22 bytes.
  const minEocd = Math.max(0, buffer.length - 65558);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minEocd; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end-of-central-directory not found");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("zip: bad central directory entry");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    // Local header repeats the name/extra lengths; the payload follows them.
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`zip: bad local header for ${name}`);
    }
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: unsupported compression method ${method}`);
    entries.push({ name, data });
  }
  return entries;
}

/** Entries of a .tar.gz: { name, data } for regular files. */
function readTarGz(buffer) {
  const tar = gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const sizeField = header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") {
      // GNU long name: the payload names the *next* entry.
      longName = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    const full = longName || (prefix ? `${prefix}/${name}` : name);
    longName = null;
    // "0" and the legacy NUL type are regular files; directories ("5") and
    // links are not interesting here.
    if (type === "0" || type === "\0") {
      entries.push({ name: full, data: Buffer.from(data) });
    }
  }
  return entries;
}

function extract(buffer, archive, wantName) {
  const entries = archive === "zip" ? readZip(buffer) : readTarGz(buffer);
  const match = entries.find((e) => e.name === wantName || e.name.endsWith(`/${wantName}`));
  if (!match) throw new Error(`${wantName} not found in archive`);
  return match.data;
}

function looksLikeElfOrPe(buf) {
  const elf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  const pe = buf[0] === 0x4d && buf[1] === 0x5a;
  return elf || pe;
}

function isProvisioned(file) {
  try {
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    return looksLikeElfOrPe(head) && fs.statSync(file).size > 1024 * 1024;
  } catch {
    return false;
  }
}

async function installOne(key, { force, dir }) {
  const spec = ARTIFACTS[key];
  if (!spec) throw new Error(`no artifact named ${key}`);
  const dest = path.join(dir, spec.binary);
  if (!force && isProvisioned(dest)) {
    console.log(`✓ ${spec.binary} already present`);
    return dest;
  }
  const url = `${MIRROR}/${spec.url}`;
  console.log(`↓ ${spec.binary} ← ${url}`);
  const buf = await download(url);
  const actual = sha256(buf);
  if (actual !== spec.sha256) {
    throw new Error(
      `checksum mismatch for ${spec.binary}\n  expected ${spec.sha256}\n  got      ${actual}`,
    );
  }
  // Refuse a payload that is not actually an executable, even if the digest
  // somehow matched: a mis-typed table entry should not brick the engine.
  if (buf.length < 1024 * 1024) {
    throw new Error(`${spec.binary}: downloaded payload is only ${buf.length} bytes`);
  }
  const payload = extract(buf, spec.archive, spec.binary);
  if (!looksLikeElfOrPe(payload)) {
    throw new Error(`${spec.binary}: extracted payload is not an executable`);
  }
  fs.mkdirSync(dir, { recursive: true });
  // Write under a temporary name, then rename: an interrupted copy must never
  // look "already provisioned" on the next run.
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload);
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  console.log(`✓ ${spec.binary} installed (${payload.length} bytes)`);
  return dest;
}

/**
 * Provision both binaries for this host. Idempotent.
 *
 * Returns the two paths plus whatever failed, instead of throwing, so the
 * caller can enable the engine with a partial install and surface the reason —
 * a missing usque only disables tunnel restarts, not the whole daemon.
 */
export async function provision({ force = false, dir = binDir() } = {}) {
  const osName = hostOs();
  const arch = hostArch();
  const result = { dir, singbox: null, usque: null, errors: [] };
  try {
    result.singbox = await installOne(`sing-box-${osName}-${arch}`, { force, dir });
  } catch (err) {
    result.errors.push(`sing-box: ${err.message}`);
  }
  try {
    result.usque = await installOne(`usque-${osName}-${arch}`, { force, dir });
  } catch (err) {
    result.errors.push(`usque: ${err.message}`);
  }
  return result;
}

async function main() {
  const force = process.argv.includes("--force");
  const dir = binDir();
  console.log(`host: ${hostOs()}/${hostArch()} → ${dir}`);
  const result = await provision({ force, dir });
  for (const message of result.errors) console.log(`⚠ ${message}`);
  if (!result.singbox) {
    console.error("✗ sing-box is required; the engine cannot start without it");
    process.exit(1);
  }
  if (!result.usque) {
    console.log("  Tunnel restarts will fail until usque is present.");
  }
  console.log(`done: ${result.singbox}`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}

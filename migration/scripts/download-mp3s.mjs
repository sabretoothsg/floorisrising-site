#!/usr/bin/env node
// Resumable Captivate → local MP3 downloader.
//
// Reads ../floorisrising_episodes.json, downloads each cfm_episode_media_url
// to ../mp3s/<mp3_filename>. Skips files whose local size already matches
// the remote Content-Length. Re-downloads anything else (partial or missing).
//
// Run from repo root or anywhere:
//   node migration/scripts/download-mp3s.mjs
//
// Flags:
//   --concurrency=N   (default 4)
//   --only=slug,slug  (limit to specific episode slugs; useful for retries)
//   --force           (re-download even if size matches)

import { readFile, stat, mkdir, rename, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, "..");
const MANIFEST = join(MIGRATION, "floorisrising_episodes.json");
const MP3_DIR = join(MIGRATION, "mp3s");

const args = parseArgs(process.argv.slice(2));
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 4));
const ONLY = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
const FORCE = Boolean(args.force);

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1500;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=");
    out[k] = v ?? true;
  }
  return out;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

async function localSize(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function remoteSize(url) {
  // HEAD with redirect-follow. Captivate serves Content-Length; if not, we
  // signal "unknown" and the caller will just re-fetch on size mismatch.
  const r = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!r.ok) throw new Error(`HEAD ${url} -> ${r.status}`);
  const cl = r.headers.get("content-length");
  return cl ? Number(cl) : null;
}

async function downloadOne(ep, idx, total) {
  const tag = `[${String(idx).padStart(2, "0")}/${total}] ep${ep.cfm_episode_itunes_number} ${ep.slug}`;
  const dest = join(MP3_DIR, ep.mp3_filename);
  const tmp = `${dest}.part`;

  let remote;
  try {
    remote = await remoteSize(ep.cfm_episode_media_url);
  } catch (e) {
    console.error(`${tag} HEAD failed: ${e.message}`);
    return { status: "error", ep, error: e.message };
  }

  const local = await localSize(dest);
  if (!FORCE && local !== null && remote !== null && local === remote) {
    console.log(`${tag} skip (have ${fmtBytes(local)})`);
    return { status: "skip", ep, bytes: local };
  }
  if (!FORCE && local !== null && remote === null) {
    // We can't verify size, but a non-zero local file probably means we got it.
    // Be conservative: only auto-skip if local file is at least 1 MB.
    if (local >= 1_000_000) {
      console.log(`${tag} skip (local ${fmtBytes(local)}, remote size unknown)`);
      return { status: "skip", ep, bytes: local };
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await fetch(ep.cfm_episode_media_url, { redirect: "follow" });
      if (!r.ok || !r.body) throw new Error(`GET -> ${r.status}`);
      // Stream into .part then rename — never leave a half-written final file.
      await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp));
      const got = await localSize(tmp);
      if (remote !== null && got !== remote) {
        await unlink(tmp).catch(() => {});
        throw new Error(`size mismatch (got ${got}, expected ${remote})`);
      }
      await rename(tmp, dest);
      console.log(`${tag} ok (${fmtBytes(got)})`);
      return { status: "downloaded", ep, bytes: got };
    } catch (e) {
      await unlink(tmp).catch(() => {});
      if (attempt === MAX_RETRIES) {
        console.error(`${tag} FAILED after ${attempt} attempts: ${e.message}`);
        return { status: "error", ep, error: e.message };
      }
      const wait = RETRY_BASE_MS * attempt;
      console.warn(`${tag} attempt ${attempt} failed (${e.message}); retrying in ${wait}ms`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}

async function runPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i + 1, items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  await mkdir(MP3_DIR, { recursive: true });

  const all = JSON.parse(await readFile(MANIFEST, "utf8"));
  const episodes = ONLY ? all.filter((e) => ONLY.has(e.slug)) : all;
  if (ONLY && episodes.length !== ONLY.size) {
    const found = new Set(episodes.map((e) => e.slug));
    const missing = [...ONLY].filter((s) => !found.has(s));
    console.warn(`--only requested ${ONLY.size} slugs; ${missing.length} not in manifest: ${missing.join(", ")}`);
  }

  console.log(`Downloading ${episodes.length} MP3s with concurrency=${CONCURRENCY}${FORCE ? " (force)" : ""}`);
  console.log(`Cache dir: ${MP3_DIR}`);
  console.log("");

  const t0 = Date.now();
  const results = await runPool(episodes, downloadOne, CONCURRENCY);

  const counts = { downloaded: 0, skip: 0, error: 0 };
  let bytes = 0;
  const errors = [];
  for (const r of results) {
    counts[r.status]++;
    if (r.bytes) bytes += r.bytes;
    if (r.status === "error") errors.push(r);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log(`Done in ${dt}s — downloaded ${counts.downloaded}, skipped ${counts.skip}, errors ${counts.error}`);
  console.log(`Total local size accounted for: ${fmtBytes(bytes)}`);

  if (errors.length) {
    console.error("");
    console.error("Failed episodes (rerun with --only to retry):");
    for (const r of errors) console.error(`  ${r.ep.slug}  —  ${r.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

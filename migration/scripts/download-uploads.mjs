#!/usr/bin/env node
// Download every /wp-content/uploads/<path> URL referenced in our markdown
// (posts, episodes) from the old WordPress origin at the GCP IP, and save
// to public/wp-content/uploads/<path> so the same root-relative URLs keep
// working on the new Astro site.
//
// We can't use DNS to reach the origin — public DNS now points at Cloudflare
// Pages. We invoke `curl --resolve` per file, which keeps SNI/Host = origin
// hostname (so the cert validates) while connecting to the GCP IP.
//
// Idempotent: skips files we already have at the right size.

import { readdir, readFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const POSTS_DIR = join(REPO_ROOT, "src", "content", "posts");
const EPISODES_DIR = join(REPO_ROOT, "src", "content", "episodes");
const OUT_BASE = join(REPO_ROOT, "public");

const ORIGIN_HOST = "www.floorisrising.com";
const ORIGIN_IP = "35.209.19.126";
const CONCURRENCY = 6;

// Match root-relative refs only — exclude substrings that are part of an
// external URL like https://otherdomain.com/wp-content/uploads/... .
const URL_RE = /(?<![:/a-z0-9.-])\/wp-content\/uploads\/[^\s)"'<>]+/g;

async function collectReferences() {
  const set = new Set();
  for (const dir of [POSTS_DIR, EPISODES_DIR]) {
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const text = await readFile(join(dir, f), "utf8");
      for (const m of text.matchAll(URL_RE)) set.add(m[0]);
    }
  }
  return [...set];
}

function localPathFor(uploadPath) {
  return join(OUT_BASE, uploadPath.replace(/^\/+/, ""));
}

async function localSize(p) {
  try {
    const s = await stat(p);
    return s.isFile() ? s.size : null;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function curlSpawn(args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn("curl", args, { ...opts });
    let stderr = "";
    p.stderr?.on("data", (b) => (stderr += b.toString()));
    p.on("error", rej);
    p.on("close", (code) => {
      if (code === 0) res();
      else rej(new Error(`curl exit ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

async function curlHeadSize(uploadPath) {
  return new Promise((res) => {
    const args = [
      "-sI",
      "--resolve", `${ORIGIN_HOST}:443:${ORIGIN_IP}`,
      "-L", // follow redirects
      "--max-time", "30",
      `https://${ORIGIN_HOST}${uploadPath}`,
    ];
    const p = spawn("curl", args);
    let out = "";
    p.stdout.on("data", (b) => (out += b.toString()));
    p.on("close", () => {
      const m = /content-length:\s*(\d+)/i.exec(out);
      res(m ? Number(m[1]) : null);
    });
    p.on("error", () => res(null));
  });
}

async function downloadOne(uploadPath, idx, total) {
  const tag = `[${String(idx).padStart(3, "0")}/${total}]`;
  const dest = localPathFor(uploadPath);
  const tmp = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });

  const remote = await curlHeadSize(uploadPath);
  const have = await localSize(dest);
  if (have !== null && remote !== null && have === remote) {
    console.log(`${tag} skip ${uploadPath} (${have} bytes)`);
    return { ok: true, path: uploadPath, bytes: have, skipped: true };
  }

  const args = [
    "-sf", // silent, fail on HTTP error
    "--resolve", `${ORIGIN_HOST}:443:${ORIGIN_IP}`,
    "-L",
    "--max-time", "120",
    "-o", tmp,
    `https://${ORIGIN_HOST}${uploadPath}`,
  ];

  try {
    await curlSpawn(args);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    console.error(`${tag} ERROR ${uploadPath}: ${e.message}`);
    return { ok: false, path: uploadPath, error: e.message };
  }

  const got = await localSize(tmp);
  if (remote !== null && got !== remote) {
    await unlink(tmp).catch(() => {});
    console.error(`${tag} ERROR ${uploadPath}: size ${got} vs expected ${remote}`);
    return { ok: false, path: uploadPath, error: `size ${got} vs ${remote}` };
  }
  await rename(tmp, dest);
  console.log(`${tag} ok   ${uploadPath} (${got} bytes)`);
  return { ok: true, path: uploadPath, bytes: got };
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
  const refs = (await collectReferences()).sort();
  console.log(`Found ${refs.length} unique /wp-content/uploads/ references in markdown.`);
  if (!refs.length) return;

  const results = await runPool(refs, downloadOne, CONCURRENCY);
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const totalBytes = ok.reduce((a, r) => a + (r.bytes || 0), 0);
  console.log("");
  console.log(`Downloaded/verified ${ok.length}/${refs.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`);
  if (failed.length) {
    console.error(`Failures (${failed.length}):`);
    for (const f of failed) console.error(`  ${f.path}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

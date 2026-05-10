#!/usr/bin/env node
// Upload local MP3s to R2 (S3-compatible). Dry-run by default.
//
// Reads ../floorisrising_episodes.json + ../mp3s/*.mp3, plans uploads against
// the bucket named in $R2_BUCKET, and (with --apply) actually writes them.
// After --apply, also verifies each object via S3 HEAD and a public GET to
// $R2_PUBLIC_BASE/<filename>.
//
//   node scripts/upload-r2.mjs              # dry-run; prints plan
//   node scripts/upload-r2.mjs --apply      # do uploads + verify
//   node scripts/upload-r2.mjs --only=slug,slug   # limit
//   node scripts/upload-r2.mjs --concurrency=4

import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, "..");
const MANIFEST = join(MIGRATION, "floorisrising_episodes.json");
const MP3_DIR = join(MIGRATION, "mp3s");

const args = parseArgs(process.argv.slice(2));
const APPLY = Boolean(args.apply);
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 4));
const ONLY = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;

const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE"];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k} (load via dotenv from .env in repo root or migration/)`);
    process.exit(1);
  }
}
const ENDPOINT =
  process.env.R2_ENDPOINT ||
  `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const BUCKET = process.env.R2_BUCKET;
const PUBLIC_BASE = process.env.R2_PUBLIC_BASE.replace(/\/$/, "");

const s3 = new S3Client({
  region: "auto",
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

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

async function listBucket() {
  const out = new Map();
  let token;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token })
    );
    for (const o of r.Contents ?? []) out.set(o.Key, { size: o.Size, etag: o.ETag });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function localStat(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function buildPlan(manifest, bucket) {
  const plan = [];
  for (const ep of manifest) {
    const key = ep.mp3_filename;
    const localPath = join(MP3_DIR, key);
    const localSize = await localStat(localPath);
    const remote = bucket.get(key);
    let action;
    if (localSize === null) action = "MISSING_LOCAL";
    else if (!remote) action = "NEW";
    else if (remote.size === localSize) action = "SKIP";
    else action = "REPLACE";
    plan.push({ ep, key, localPath, localSize, remoteSize: remote?.size ?? null, action });
  }
  return plan;
}

function summarize(plan) {
  const counts = {};
  let totalNew = 0,
    totalReplace = 0;
  for (const p of plan) {
    counts[p.action] = (counts[p.action] || 0) + 1;
    if (p.action === "NEW") totalNew += p.localSize ?? 0;
    if (p.action === "REPLACE") totalReplace += p.localSize ?? 0;
  }
  return { counts, totalNew, totalReplace };
}

async function uploadOne(p) {
  const tag = `[ep${p.ep.cfm_episode_itunes_number}] ${p.key}`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: p.key,
        Body: createReadStream(p.localPath),
        ContentType: "audio/mpeg",
        ContentLength: p.localSize,
        // R2 sets metadata; CacheControl stays Cloudflare default. Custom domain
        // serves these publicly per the bucket's existing config.
      })
    );
  } catch (e) {
    return { ok: false, key: p.key, where: "put", error: e.message };
  }

  // Verify via S3 HEAD
  try {
    const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: p.key }));
    if (h.ContentLength !== p.localSize) {
      return { ok: false, key: p.key, where: "head", error: `size ${h.ContentLength} != ${p.localSize}` };
    }
  } catch (e) {
    return { ok: false, key: p.key, where: "head", error: e.message };
  }

  // Verify via public GET (HEAD on the custom domain)
  try {
    const url = `${PUBLIC_BASE}/${encodeURIComponent(p.key)}`;
    const r = await fetch(url, { method: "HEAD" });
    if (!r.ok) return { ok: false, key: p.key, where: "public", error: `${r.status}` };
    const cl = Number(r.headers.get("content-length"));
    if (cl !== p.localSize) {
      return { ok: false, key: p.key, where: "public", error: `size ${cl} != ${p.localSize}` };
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.startsWith("audio/")) {
      return { ok: false, key: p.key, where: "public", error: `content-type ${ct}` };
    }
  } catch (e) {
    return { ok: false, key: p.key, where: "public", error: e.message };
  }

  console.log(`${tag} uploaded (${fmtBytes(p.localSize)})`);
  return { ok: true, key: p.key };
}

async function runPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const all = JSON.parse(await readFile(MANIFEST, "utf8"));
  const manifest = ONLY ? all.filter((e) => ONLY.has(e.slug)) : all;

  console.log(`Bucket: ${BUCKET}`);
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Public base: ${PUBLIC_BASE}`);
  console.log(`Local cache: ${MP3_DIR}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}    Concurrency: ${CONCURRENCY}`);
  console.log("");

  console.log("Listing existing bucket contents...");
  const bucket = await listBucket();
  console.log(`Bucket currently has ${bucket.size} object(s).`);
  console.log("");

  const plan = await buildPlan(manifest, bucket);
  const { counts, totalNew, totalReplace } = summarize(plan);

  // Print plan in stable order (ep#)
  for (const p of plan) {
    const line = `[ep${String(p.ep.cfm_episode_itunes_number).padStart(2, "0")}] ${p.action.padEnd(13)}  ${fmtBytes(p.localSize ?? 0).padStart(9)}  ${p.key}`;
    console.log(line);
  }
  console.log("");
  console.log(`Plan summary: ${JSON.stringify(counts)}`);
  console.log(`Bytes to upload: ${fmtBytes(totalNew + totalReplace)} (NEW ${fmtBytes(totalNew)} + REPLACE ${fmtBytes(totalReplace)})`);
  console.log("");

  if (counts.MISSING_LOCAL) {
    console.error("Cannot proceed while any episodes are MISSING_LOCAL — run download-mp3s.mjs first.");
    if (APPLY) process.exit(2);
  }

  if (!APPLY) {
    console.log("Dry-run complete. Re-run with --apply to upload.");
    return;
  }

  // Apply
  const todo = plan.filter((p) => p.action === "NEW" || p.action === "REPLACE");
  console.log(`Uploading ${todo.length} object(s)...`);
  const results = await runPool(todo, uploadOne, CONCURRENCY);
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`Uploaded ${results.length - failed.length}/${results.length}.`);
  if (failed.length) {
    console.error("Failures:");
    for (const f of failed) console.error(`  ${f.key} (${f.where}): ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

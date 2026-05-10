#!/usr/bin/env node
// WXR → src/content/episodes/<slug>.md (one file per published captivate_podcast).
//
// Frontmatter pulls the canonical iTunes/Captivate fields from the JSON manifest
// (which we already validated to be complete) and the body comes from
// content:encoded converted via turndown. mp3Bytes is read from the local
// download cache so the RSS <enclosure length="…"> is correct.

import { readFile, writeFile, stat, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import TurndownService from "turndown";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, "..");
const REPO_ROOT = resolve(MIGRATION, "..");
const WXR = join(MIGRATION, "floorisrisingnftpodcast.WordPress.2026-05-10.xml");
const MANIFEST = join(MIGRATION, "floorisrising_episodes.json");
const MP3_DIR = join(MIGRATION, "mp3s");
const OUT_DIR = join(REPO_ROOT, "src", "content", "episodes");

const parser = new XMLParser({
  ignoreAttributes: false,
  cdataPropName: "__cdata",
  parseTagValue: false,
  trimValues: false,
});

function val(node) {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node === "object" && "__cdata" in node) return node.__cdata;
  if (typeof node === "object" && "#text" in node) return node["#text"];
  return null;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
});
// Preserve plain links nicely; strip empty paragraphs and stray <div> wrappers.
turndown.addRule("stripEmptyDiv", {
  filter: (node) => node.nodeName === "DIV" && !node.textContent.trim() && !node.querySelector("img,iframe"),
  replacement: () => "",
});

function yamlString(s) {
  if (s == null) return '""';
  // Quote and escape — YAML needs double quotes if the string has : or starts with special chars.
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function toIsoDate(s) {
  // "2021-10-21 09:00:00" (treated as GMT per WXR post_date_gmt) → ISO
  if (!s) return null;
  const [d, t] = s.trim().split(" ");
  return `${d}T${t || "00:00:00"}Z`;
}

async function localBytes(filename) {
  try {
    const s = await stat(join(MP3_DIR, filename));
    return s.size;
  } catch {
    return null;
  }
}

async function main() {
  const xml = await readFile(WXR, "utf8");
  const doc = parser.parse(xml);
  const items = doc.rss.channel.item;
  const episodes = items.filter(
    (it) => val(it["wp:post_type"]) === "captivate_podcast" && val(it["wp:status"]) === "publish"
  );

  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const bySlug = new Map(manifest.map((e) => [e.slug, e]));

  // Fresh dir each time — episode set comes only from the WXR + manifest.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const written = [];
  const missing = [];
  for (const it of episodes) {
    const slug = val(it["wp:post_name"]);
    const m = bySlug.get(slug);
    if (!m) {
      missing.push(slug);
      continue;
    }

    const title = val(it.title) || m.title;
    const pubDate = toIsoDate(val(it["wp:post_date_gmt"]) || m.date);
    const html = val(it["content:encoded"]) || "";
    const body = turndown.turndown(html).trim();
    const bytes = await localBytes(m.mp3_filename);

    const fm = [
      "---",
      `title: ${yamlString(title)}`,
      `slug: ${yamlString(slug)}`,
      `pubDate: ${pubDate}`,
      `season: ${Number(m.cfm_episode_itunes_season) || 1}`,
      `episodeNumber: ${Number(m.cfm_episode_itunes_number)}`,
      `itunesType: ${m.cfm_episode_itunes_type || "full"}`,
      `explicit: ${m.cfm_episode_itunes_explicit === "yes"}`,
      `mp3Filename: ${yamlString(m.mp3_filename)}`,
      bytes != null ? `mp3Bytes: ${bytes}` : `# mp3Bytes: unknown (file not in migration/mp3s)`,
      `artworkUrl: ${yamlString(m.cfm_episode_artwork)}`,
      `subtitle: ${yamlString(m.cfm_episode_itunes_subtitle || "")}`,
      `summary: ${yamlString(m.cfm_episode_itunes_summary || "")}`,
      `captivateEpisodeId: ${yamlString(m.cfm_episode_id)}`,
      `legacyPath: ${yamlString(`/podcast/${slug}/`)}`,
      "---",
      "",
      body,
      "",
    ].join("\n");

    await writeFile(join(OUT_DIR, `${slug}.md`), fm);
    written.push(slug);
  }

  console.log(`Wrote ${written.length} episode markdown files to ${OUT_DIR}`);
  if (missing.length) {
    console.warn(`WARNING: ${missing.length} episode slug(s) in WXR have no manifest entry:`);
    for (const s of missing) console.warn(`  ${s}`);
  }
  // Also flag manifest entries we didn't see in WXR
  const seen = new Set(written);
  const unseen = manifest.filter((e) => !seen.has(e.slug));
  if (unseen.length) {
    console.warn(`WARNING: ${unseen.length} manifest slug(s) not present as published episodes in WXR:`);
    for (const e of unseen) console.warn(`  ${e.slug}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

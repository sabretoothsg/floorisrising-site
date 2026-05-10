#!/usr/bin/env node
// WXR → src/content/posts/<slug>.md (one file per published `post`).
//
// Side-effects baked into the body:
//   - Captivate <iframe> embed for an episode → stripped; we record the
//     paired episode slug in frontmatter (`pairedEpisodeSlug`) so the
//     post layout can render our own R2-backed player.
//   - Image URLs at https://www.floorisrising.com/wp-content/uploads/ →
//     rewritten to /wp-content/uploads/ (root-relative) so they keep working
//     once the same domain points at Pages and we drop the files into
//     public/wp-content/uploads/.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import TurndownService from "turndown";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, "..");
const REPO_ROOT = resolve(MIGRATION, "..");
const WXR = join(MIGRATION, "floorisrisingnftpodcast.WordPress.2026-05-10.xml");
const MANIFEST = join(MIGRATION, "floorisrising_episodes.json");
const OUT_DIR = join(REPO_ROOT, "src", "content", "posts");

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

function yamlString(s) {
  if (s == null) return '""';
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function toIsoDate(s) {
  if (!s) return null;
  const [d, t] = s.trim().split(" ");
  return `${d}T${t || "00:00:00"}Z`;
}

const CAPTIVATE_EMBED = /<iframe[^>]*player\.captivate\.fm\/episode\/([0-9a-f-]+)[^>]*>\s*<\/iframe>/gi;
const CAPTIVATE_DIV_WRAPPER = /<div[^>]*>\s*(<iframe[^>]*player\.captivate\.fm\/episode\/[0-9a-f-]+[^>]*>\s*<\/iframe>)\s*<\/div>/gi;

const UPLOADS_RE = /https?:\/\/(?:www\.)?floorisrising\.com\/wp-content\/uploads\//gi;

function rewriteHtml(html) {
  let pairedId = null;
  // Capture the first Captivate episode ID we see, then strip the iframes
  // (and any tight <div> wrapper around them).
  let h = html.replace(CAPTIVATE_DIV_WRAPPER, (_, iframe) => {
    const m = /episode\/([0-9a-f-]+)/i.exec(iframe);
    if (m && !pairedId) pairedId = m[1];
    return "";
  });
  h = h.replace(CAPTIVATE_EMBED, (_, id) => {
    if (!pairedId) pairedId = id;
    return "";
  });
  // Root-relative the upload URLs.
  h = h.replace(UPLOADS_RE, "/wp-content/uploads/");
  return { html: h, pairedId };
}

async function main() {
  const xml = await readFile(WXR, "utf8");
  const doc = parser.parse(xml);
  const items = doc.rss.channel.item;
  const posts = items.filter(
    (it) => val(it["wp:post_type"]) === "post" && val(it["wp:status"]) === "publish"
  );

  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const byCaptivateId = new Map(manifest.map((e) => [e.cfm_episode_id, e]));

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  let withPair = 0,
    withoutPair = 0;
  for (const it of posts) {
    const slug = val(it["wp:post_name"]);
    const title = val(it.title) || slug;
    const pubDate = toIsoDate(val(it["wp:post_date_gmt"]));
    const rawHtml = val(it["content:encoded"]) || "";
    const { html, pairedId } = rewriteHtml(rawHtml);
    const body = turndown.turndown(html).trim();
    const paired = pairedId ? byCaptivateId.get(pairedId) : null;
    if (paired) withPair++;
    else withoutPair++;

    const fm = [
      "---",
      `title: ${yamlString(title)}`,
      `slug: ${yamlString(slug)}`,
      `pubDate: ${pubDate}`,
      paired ? `pairedEpisodeSlug: ${yamlString(paired.slug)}` : `# pairedEpisodeSlug: none`,
      `legacyPath: ${yamlString(`/${slug}/`)}`,
      "---",
      "",
      body,
      "",
    ].join("\n");

    await writeFile(join(OUT_DIR, `${slug}.md`), fm);
  }

  console.log(`Wrote ${posts.length} post markdown files to ${OUT_DIR}`);
  console.log(`  paired with episode: ${withPair}`);
  console.log(`  no paired episode:   ${withoutPair}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

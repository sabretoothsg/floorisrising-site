import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { r2Url } from "../../lib/r2";

const SITE = "https://floorisrising.com";
const FEED_TITLE = "Floor is Rising";
const FEED_AUTHOR = "Floor is Rising";
const FEED_OWNER_NAME = "Floor is Rising";
const FEED_OWNER_EMAIL = "hello@floorisrising.com";
const FEED_DESCRIPTION =
  "Long-form interviews and conversations from the NFT and crypto art scene.";
const FEED_LANGUAGE = "en-us";
const FEED_CATEGORY = "Arts";
const FEED_SUBCATEGORY = "Visual Arts";
const FEED_IMAGE = `${SITE}/podcast-cover.png`;
const FEED_EXPLICIT = false;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(d: Date): string {
  return d.toUTCString();
}

export const GET: APIRoute = async () => {
  const episodes = (await getCollection("episodes")).sort(
    (a, b) => a.data.episodeNumber - b.data.episodeNumber
  );

  const lastBuild = rfc822(new Date());
  const latest = episodes[episodes.length - 1];
  const latestPub = latest ? rfc822(latest.data.pubDate) : lastBuild;

  const items = episodes
    .map((ep) => {
      const {
        title,
        episodeNumber,
        season,
        pubDate,
        subtitle,
        summary,
        explicit,
        itunesType,
        mp3Filename,
        mp3Bytes,
        artworkUrl,
        captivateEpisodeId,
      } = ep.data;

      const url = `${SITE}/podcast/${ep.slug}/`;
      const enclosureUrl = r2Url(mp3Filename);
      const description = summary || subtitle || "";
      const guid = captivateEpisodeId
        ? `captivate:${captivateEpisodeId}`
        : url;

      return `
    <item>
      <title>${xmlEscape(title)}</title>
      <link>${xmlEscape(url)}</link>
      <guid isPermaLink="false">${xmlEscape(guid)}</guid>
      <pubDate>${rfc822(pubDate)}</pubDate>
      <description><![CDATA[${description}]]></description>
      <enclosure url="${xmlEscape(enclosureUrl)}" length="${mp3Bytes ?? 0}" type="audio/mpeg" />
      <itunes:title>${xmlEscape(title)}</itunes:title>
      <itunes:season>${season}</itunes:season>
      <itunes:episode>${episodeNumber}</itunes:episode>
      <itunes:episodeType>${itunesType}</itunes:episodeType>
      <itunes:explicit>${explicit ? "true" : "false"}</itunes:explicit>
      ${subtitle ? `<itunes:subtitle>${xmlEscape(subtitle)}</itunes:subtitle>` : ""}
      ${summary ? `<itunes:summary><![CDATA[${summary}]]></itunes:summary>` : ""}
      ${artworkUrl ? `<itunes:image href="${xmlEscape(artworkUrl)}" />` : ""}
    </item>`;
    })
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <atom:link href="${SITE}/feed/podcast.xml" rel="self" type="application/rss+xml" />
    <title>${xmlEscape(FEED_TITLE)}</title>
    <link>${SITE}</link>
    <description><![CDATA[${FEED_DESCRIPTION}]]></description>
    <language>${FEED_LANGUAGE}</language>
    <copyright>© Floor is Rising</copyright>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <pubDate>${latestPub}</pubDate>
    <itunes:author>${xmlEscape(FEED_AUTHOR)}</itunes:author>
    <itunes:summary><![CDATA[${FEED_DESCRIPTION}]]></itunes:summary>
    <itunes:type>episodic</itunes:type>
    <itunes:explicit>${FEED_EXPLICIT ? "true" : "false"}</itunes:explicit>
    <itunes:owner>
      <itunes:name>${xmlEscape(FEED_OWNER_NAME)}</itunes:name>
      <itunes:email>${xmlEscape(FEED_OWNER_EMAIL)}</itunes:email>
    </itunes:owner>
    <itunes:image href="${xmlEscape(FEED_IMAGE)}" />
    <itunes:category text="${xmlEscape(FEED_CATEGORY)}">
      <itunes:category text="${xmlEscape(FEED_SUBCATEGORY)}" />
    </itunes:category>${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
    },
  });
};

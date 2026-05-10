# Floor is Rising

Static site for the *Floor is Rising* NFT podcast. Built with Astro, deployed to Cloudflare Pages, MP3s served from Cloudflare R2 (`media.floorisrising.com`).

## Local development

```sh
npm install
npm run dev          # http://localhost:4321
npm run build        # → dist/
npm run preview
```

## Repo layout

```
src/
  content/episodes/  — 80 episode markdown files
  content/posts/     — 41 show-notes posts
  pages/             — routes
    podcast/[slug]   — episode detail (URL stable from old WP site)
    blog/[slug]      — post detail
    feed/podcast.xml — iTunes-compliant RSS
  components/        — Header, Footer, AudioPlayer, EpisodeCard
  layouts/           — BaseLayout, EpisodeLayout, PostLayout
  lib/r2.ts          — R2 public URL builder
public/
  _redirects         — legacy /<slug>/ → /blog/<slug>/, /episode → /podcast/, etc.
  robots.txt
  favicon.svg
migration/           — one-time tooling (gitignored mp3s + WXR source)
```

## Adding a new episode

1. Drop the MP3 in the R2 bucket (`floorisrising-media`) at any filename.
2. Create `src/content/episodes/<slug>.md` with the frontmatter pattern used by existing episodes (see `src/content/config.ts` for the schema).
3. Commit + push. Cloudflare Pages rebuilds.

The RSS feed reads `mp3Filename` and `mp3Bytes` from frontmatter — make sure `mp3Bytes` matches the actual file size.

## Migration scripts

In `migration/` (separate `package.json`):

- `download-mp3s.mjs` — pull all 80 MP3s from Captivate into `migration/mp3s/`. Resumable.
- `upload-r2.mjs` — sync `migration/mp3s/` to R2. Dry-run by default; pass `--apply` to write.
- `parse-wxr-episodes.mjs` — regenerate `src/content/episodes/*.md` from the WXR + manifest.
- `parse-wxr-posts.mjs` — regenerate `src/content/posts/*.md` from the WXR.
- `generate-redirects.mjs` — regenerate `public/_redirects`.

These shouldn't normally need to run again post-migration.

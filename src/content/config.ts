import { defineCollection, z } from "astro:content";

const episodes = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    season: z.number().int().default(1),
    episodeNumber: z.number().int(),
    itunesType: z.enum(["full", "trailer", "bonus"]).default("full"),
    explicit: z.boolean().default(false),
    mp3Filename: z.string(),
    mp3Bytes: z.number().int().optional(),
    artworkUrl: z.string().url().optional(),
    subtitle: z.string().default(""),
    summary: z.string().default(""),
    captivateEpisodeId: z.string().optional(),
    legacyPath: z.string().optional(),
  }),
});

const posts = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    pairedEpisodeSlug: z.string().optional(),
    legacyPath: z.string().optional(),
  }),
});

export const collections = { episodes, posts };

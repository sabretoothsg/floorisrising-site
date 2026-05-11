// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://floorisrising.com",
  trailingSlash: "ignore",

  build: {
    format: "directory",
  },

  integrations: [sitemap()],
  adapter: cloudflare()
});
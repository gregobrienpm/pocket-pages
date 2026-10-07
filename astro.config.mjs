// @ts-check
import { defineConfig } from "astro/config";

// Set `site` once the domain is bought (used for canonical URLs and social cards).
export default defineConfig({
  site: process.env.SITE_URL || "https://example.com",
  output: "static",
});

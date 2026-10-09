// @ts-check
import { defineConfig } from "astro/config";

// Canonical URLs and social cards. SITE_URL can override it (e.g. for a preview).
export default defineConfig({
  site: process.env.SITE_URL || "https://readpocketpages.com",
  output: "static",
});

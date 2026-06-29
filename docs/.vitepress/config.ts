import { defineConfig } from "vitepress";

const repositoryName = "journeytest-core";
const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
  title: "JourneyTest",
  description: "AI-agent-directed user journey testing for web apps.",
  base,
  lang: "en-US",
  lastUpdated: true,
  sitemap: {
    hostname: `https://jules-astier.github.io/${repositoryName}/`,
  },
  head: [
    ["meta", { name: "theme-color", content: "#111827" }],
    [
      "meta",
      {
        property: "og:title",
        content: "JourneyTest Documentation",
      },
    ],
    [
      "meta",
      {
        property: "og:description",
        content: "Documentation for JourneyTest user journey testing.",
      },
    ],
  ],
  themeConfig: {
    search: {
      provider: "local",
    },
    nav: [
      { text: "Product", link: "/product/" },
      { text: "Architecture", link: "/architecture/" },
      { text: "Authoring", link: "/authoring/" },
      { text: "Running", link: "/running/" },
      { text: "Lifecycle", link: "/lifecycle/" },
      { text: "Reference", link: "/reference/" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Docs Home", link: "/" },
          { text: "Documentation Log", link: "/log" },
        ],
      },
      {
        text: "Product",
        items: [
          { text: "Overview", link: "/product/overview" },
          { text: "Feature Catalog", link: "/product/features" },
        ],
      },
      {
        text: "Architecture",
        items: [{ text: "How It Works", link: "/architecture/how-it-works" }],
      },
      {
        text: "Authoring",
        items: [
          { text: "Journey JSON", link: "/authoring/journey-json" },
          { text: "Agent Skills", link: "/authoring/agent-skills" },
        ],
      },
      {
        text: "Running",
        items: [{ text: "Running Journeys", link: "/running/running-journeys" }],
      },
      {
        text: "Lifecycle",
        items: [{ text: "Data Lifecycle", link: "/lifecycle/data-lifecycle" }],
      },
      {
        text: "Reference",
        items: [{ text: "Run Artifacts", link: "/reference/artifacts" }],
      },
    ],
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/Jules-Astier/journeytest-core",
      },
      {
        icon: "npm",
        link: "https://www.npmjs.com/package/@baguette-studios/journeytest-core",
      },
    ],
    editLink: {
      pattern:
        "https://github.com/Jules-Astier/journeytest-core/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 Jules Astier",
    },
  },
});

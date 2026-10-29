# Updating the changelog

Edit `changelog.ts` to add or update the entry for a day. Use a `YYYY-MM-DD` date
and put updates in `features` or `fixes`. Each item has a short `title` for the
bullet and `details` that readers can expand. Leave out categories with no updates.

```ts
{
  date: "2026-10-11",
  features: [
    {
      title: "Short feature summary",
      details: "Explain what changed and how to use it.",
    },
  ],
  fixes: [
    {
      title: "Short fix summary",
      details: "Explain the issue and the corrected behavior.",
    },
  ],
},
```

Use one entry per date and add bullets to it throughout the day. The page sorts
dates newest first automatically. Only include changes that are available to users.

The website is statically exported, so content updates appear after the site is
rebuilt and deployed through the normal release process. To preview locally,
run `bun dev:site` from the repository root and open `/changelog` on port 3001.

## Search discovery

The static export includes `/robots.txt` and `/sitemap.xml`. Both use
`NEXT_PUBLIC_SITE_URL`, which also sets the base URL for page metadata. Set it to
the public site origin when building for deployment; it defaults to
`https://tidydesign.co`.

`app/robots.ts` allows crawling of the public site and links to the sitemap.
`app/sitemap.ts` lists only public, canonical pages on this site. Add an entry
when publishing a new page, and give that page its own canonical metadata.
Account and workspace URLs on the separate app domain do not belong here.

The sitemap omits modification dates until accurate page update dates are
available; a rebuild is not a content update. It also omits priority and change
frequency, which Google ignores.

Run `bun run build:site` from the repository root and inspect
`apps/site/out/robots.txt` and `apps/site/out/sitemap.xml` before release. After
deployment, check the served files as well: CDN crawler controls may add rules
or restrict access independently of the exported files. Submit the sitemap in
Search Console to monitor discovery and indexing.

## Writing a blog post

Add a Markdown file to `content/blog/`. Its kebab-case filename becomes the URL:
`design-to-code-workflow.md` is `/blog/design-to-code-workflow`.

```md
---
title: "Your article title"
description: "A specific summary of what the reader will learn."
date: "2026-10-29"
category: "Design to code"
artwork: "cloud-spectrum"
draft: true
---

Start with the question or problem your article answers.

## Your first section

Write the article in Markdown.
```

Required fields are `title`, `description`, `date`, `category` and `artwork`.
Use optional `seoTitle` for a descriptive search and sharing title while keeping
the editorial headline on the page.
Quote dates as `YYYY-MM-DD`. Artwork is `cloud-spectrum` or `cloud-coral`.
An optional `updated` date must be on or after `date`; change it only for an actual
content update. The shared byline is Tidy and links to the founders on `/about`.

Set `draft: true` to exclude a post from pages, navigation and the sitemap. Remove
it or set it to `false` when ready for the next site build. Dates do not schedule
publication: every non-draft post is included at build time. Posts are sorted by
date, then filename for ties. The homepage features the two newest posts.

Use `##` and `###` for headings; the page supplies the single `h1`. Standard
Markdown and GitHub-flavored tables, lists, links, quotes and fenced code blocks
are supported. Raw HTML is ignored and JavaScript/MDX is not executed. Use
root-relative links for other site pages and full HTTPS URLs for external sources.

The index, individual article HTML, metadata, related links and sitemap entries
are generated automatically. A rebuild is required after edits. Run
`bun run build:site` and inspect `apps/site/out/blog/` before publishing. Review
starter article copy and publication dates before the first deployment.

## Founder profiles

`founders.ts` holds the verified GitHub and LinkedIn links. The WebP portraits in
`public/founders/` are copies of each founder’s GitHub avatar, retrieved on
2026-10-29 (`seandowdall` and `tadhgdowdall`). Refresh these local files when needed;
site visitors do not make requests to GitHub for the portraits.

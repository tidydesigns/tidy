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

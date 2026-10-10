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

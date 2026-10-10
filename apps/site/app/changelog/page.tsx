import type { Metadata } from "next";
import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";
import { changelog, type ChangelogItem } from "../../content/changelog";

export const metadata: Metadata = {
  title: "Changelog — Tidy",
  description: "The latest features and fixes in Tidy, day by day.",
  alternates: { canonical: "/changelog" },
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function ChangeList({ title, items }: { title: string; items?: readonly ChangelogItem[] }) {
  if (!items?.length) return null;

  return (
    <div className="change-group">
      <h3>{title}</h3>
      <ul className="change-list">
        {items.map((item) => (
          <li key={item.title}>
            <details className="change-details">
              <summary>
                <span>{item.title}</span>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </summary>
              <p>{item.details}</p>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ChangelogPage() {
  const entries = [...changelog].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="page">
      <SiteHeader currentPage="changelog" />
      <main className="changelog-content">
        <div className="changelog-intro">
          <h1>Changelog</h1>
          <p>What’s new and what’s fixed in Tidy.</p>
        </div>
        {entries.map((entry) => (
          <section
            className="changelog-entry"
            key={entry.date}
            aria-labelledby={`day-${entry.date}`}
          >
            <h2 id={`day-${entry.date}`}>
              <time dateTime={entry.date}>
                {dateFormatter.format(new Date(`${entry.date}T00:00:00Z`))}
              </time>
            </h2>
            <div className="changelog-changes">
              <ChangeList title="Features" items={entry.features} />
              <ChangeList title="Fixes" items={entry.fixes} />
            </div>
          </section>
        ))}
      </main>
      <SiteFooter />
    </div>
  );
}

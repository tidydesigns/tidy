import Link from "next/link";
import { CloudFooter } from "../../components/brand/cloud-footer";
import { CloudArtwork } from "../../components/brand/cloud-artwork";
import { FounderCards } from "../../components/editorial/founder-cards";
import { StructuredData } from "../../components/structured-data";
import { founders } from "../../content/founders";
import { pageMetadata } from "../../lib/page-metadata";
import { appUrl, repositoryUrl } from "../../lib/site-links";
import { siteUrl } from "../../lib/site-url";
import styles from "../../components/editorial/editorial.module.css";

export const metadata = pageMetadata(
  "/about",
  "About Tidy",
  "Sean and Tadhg Dowdall are building Tidy, an open-source design canvas and Mac app for working with designs, code and coding agents.",
);

export default function AboutPage() {
  return (
    <>
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "AboutPage",
          name: "About Tidy",
          url: new URL("/about", siteUrl).href,
          mainEntity: {
            "@type": "Organization",
            "@id": new URL("/#organization", siteUrl).href,
            name: "Tidy",
            url: siteUrl.href,
            sameAs: [repositoryUrl],
            founder: founders.map((founder) => ({
              "@type": "Person",
              name: founder.name,
              url: new URL(`/about#${founder.id}`, siteUrl).href,
              image: new URL(founder.image, siteUrl).href,
              sameAs: [founder.github, founder.linkedin],
            })),
          },
        }}
      />
      <main id="main-content" tabIndex={-1} className={styles.page}>
        <header className={`${styles.intro} ${styles.aboutIntro}`}>
          <div>
            <h1>An open-source design tool.</h1>
            <p className={styles.lead}>
              Tidy has a design canvas in the browser and a Mac app that connects your designs,
              local code and coding agents.
            </p>
          </div>
          <div className={styles.aboutArtwork} aria-hidden="true">
            <CloudArtwork name="cloud-spectrum" sizes="(max-width: 700px) 240px, 360px" eager />
          </div>
        </header>
        <section className={styles.story} aria-labelledby="why-tidy">
          <h2 id="why-tidy">Where we’re going.</h2>
          <div>
            <p>
              We want to make it easier to use an editable design as the reference while writing
              code. We’re working on how agents read and change the canvas, and how you review their
              work.
            </p>
            <p>
              Tidy’s source code is available under the Apache 2.0 license. Development is public on
              GitHub.
            </p>
            <a className={styles.textLink} href={repositoryUrl}>
              <span>View the source on GitHub</span>
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        </section>
        <section className={styles.team} aria-labelledby="team-title">
          <div className={styles.sectionHeading}>
            <h2 id="team-title">Who we are.</h2>
          </div>
          <FounderCards />
        </section>
        <aside className={styles.nextRead}>
          <p>How we use Tidy for design and development.</p>
          <Link className={styles.textLink} href="/blog">
            <span>Read the blog</span>
            <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </main>
      <CloudFooter appUrl={appUrl} repositoryUrl={repositoryUrl} />
    </>
  );
}

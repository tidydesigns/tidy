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
  "About Tidy | Meet the founders",
  "Meet Sean and Tadhg Dowdall, the founders of Tidy. We’re building an open-source workspace that brings design, code and coding agents together.",
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
            <p className={styles.eyebrow}>About us</p>
            <h1>
              A little space.
              <br />A lot of possibility.
            </h1>
            <p className={styles.lead}>
              We’re building a place where design and code belong together. Open source, and open to
              the way you work.
            </p>
          </div>
          <div className={styles.aboutArtwork} aria-hidden="true">
            <CloudArtwork name="cloud-spectrum" sizes="(max-width: 700px) 240px, 360px" eager />
          </div>
        </header>
        <section className={styles.story} aria-labelledby="why-tidy">
          <h2 id="why-tidy">
            Good ideas deserve
            <br />
            room to become real.
          </h2>
          <div>
            <p>
              Designing an interface and building it are parts of the same process. The details you
              work out on the canvas should stay close when you move into code.
            </p>
            <p>
              Tidy brings an editable design canvas, your local project and coding agents into one
              workspace. Use the canvas in your browser, or bring design and development together in
              the Mac app.
            </p>
            <p>
              We’re building Tidy in the open under the Apache 2.0 license. You can explore the
              source, follow the work and help shape what comes next.
            </p>
            <a className={styles.textLink} href={repositoryUrl}>
              Explore Tidy on GitHub <span aria-hidden="true">↗</span>
            </a>
          </div>
        </section>
        <section className={styles.team} aria-labelledby="team-title">
          <div className={styles.sectionHeading}>
            <h2 id="team-title">The people behind Tidy.</h2>
            <p>Sean and Tadhg Dowdall. Building it together.</p>
          </div>
          <FounderCards />
        </section>
        <aside className={styles.nextRead}>
          <p>Notes on what we’re building, and how.</p>
          <Link className={styles.textLink} href="/blog">
            Read the Tidy blog <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </main>
      <CloudFooter appUrl={appUrl} repositoryUrl={repositoryUrl} />
    </>
  );
}

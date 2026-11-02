import Link from "next/link";
import { CloudFooter } from "../../components/brand/cloud-footer";
import { CloudArtwork } from "../../components/brand/cloud-artwork";
import { BrandIcon } from "../../components/brand/brand-icon";
import { FounderCards } from "../../components/editorial/founder-cards";
import { StructuredData } from "../../components/structured-data";
import { founders } from "../../content/founders";
import { getPosts } from "../../lib/blog";
import { pageMetadata } from "../../lib/page-metadata";
import { appUrl, repositoryUrl } from "../../lib/site-links";
import { siteUrl } from "../../lib/site-url";
import styles from "../../components/editorial/editorial.module.css";

export const metadata = pageMetadata(
  "/about",
  "About Tidy",
  "Sean and Tadhg Dowdall are building Tidy, an open-source workspace for designs, local projects and coding threads with Claude Code and Codex.",
);

export default async function AboutPage() {
  const showBlog = (await getPosts()).length > 0;
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
            <h1>A workspace for design and development.</h1>
            <p className={styles.lead}>
              Tidy brings your designs, local projects and coding agents together. Use the browser
              canvas, or run Claude Code and Codex threads alongside your code and designs in the
              Mac app.
            </p>
          </div>
          <div className={styles.aboutArtwork} aria-hidden="true">
            <CloudArtwork name="cloud-spectrum" sizes="(max-width: 700px) 240px, 360px" eager />
          </div>
        </header>
        <section className={styles.story} aria-labelledby="why-tidy">
          <h2 id="why-tidy">How we work.</h2>
          <div>
            <p>
              Open a local project, attach a design to a coding thread, and ask an agent to build or
              change the implementation. Run threads in parallel, review their changes, and use the
              canvas and terminal in the same workspace.
            </p>
            <p>
              Tidy’s source code is available under the Apache 2.0 license. Development is public on
              GitHub.
            </p>
            <a className={styles.textLink} href={repositoryUrl}>
              <BrandIcon name="github" />
              <span>View the source on GitHub</span>
            </a>
          </div>
        </section>
        <section className={styles.team} aria-labelledby="team-title">
          <div className={styles.sectionHeading}>
            <h2 id="team-title">Who we are.</h2>
          </div>
          <FounderCards />
        </section>
        {showBlog && (
          <aside className={styles.nextRead}>
            <p>How we use Tidy for design and development.</p>
            <Link className={styles.textLink} href="/blog">
              <span>Read the blog</span>
              <span aria-hidden="true">→</span>
            </Link>
          </aside>
        )}
      </main>
      <CloudFooter appUrl={appUrl} repositoryUrl={repositoryUrl} />
    </>
  );
}

import type { Metadata } from "next";
import { CloudFooter } from "../components/brand/cloud-footer";
import { CloudArtwork } from "../components/brand/cloud-artwork";
import { CloudAtmosphere } from "../components/brand/cloud-atmosphere";
import { BrandIcon } from "../components/brand/brand-icon";
import { ProductPreview } from "../components/machine/product-preview";
import { Workflow } from "../components/machine/workflow";
import { appUrl, downloadUrl, repositoryUrl } from "../lib/site-links";
import { pageMetadata } from "../lib/page-metadata";
import styles from "../components/machine/machine.module.css";

export const metadata: Metadata = pageMetadata(
  "/",
  "Tidy — One space. Full possibility.",
  "The open-source product development environment for designers, engineers and agents. Bring your canvas, code and coding agents together. Build with less friction.",
);

export default function HomePage() {
  return (
    <div className={styles.site}>
      <main id="main-content">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroArtwork} aria-hidden="true">
            <CloudAtmosphere eager />
            <div className={styles.cloudLeft}>
              <CloudArtwork name="cloud-coral" sizes="(max-width: 800px) 315px, 600px" eager />
            </div>
            <div className={styles.cloudRight}>
              <CloudArtwork name="cloud-spectrum" sizes="(max-width: 800px) 345px, 615px" eager />
            </div>
            <div className={styles.cloudSmallLeft}>
              <CloudArtwork name="cloud-spectrum" sizes="330px" />
            </div>
            <div className={styles.cloudSmallRight}>
              <CloudArtwork name="cloud-coral" sizes="285px" />
            </div>
          </div>
          <div className={styles.heroCopy}>
            <h1 id="hero-title">
              One space.
              <br />
              Full possibility.
            </h1>
            <p className={styles.heroDescription}>
              Bring your canvas, your code and your coding agents together.
              <br className={styles.desktopBreak} /> Build products with less friction, and a lot
              more freedom.
            </p>
            <div className={styles.heroActions}>
              <a className="button button-primary" href={downloadUrl}>
                <BrandIcon name="apple" />
                Download for macOS
              </a>
              <a className="button button-secondary" href={appUrl}>
                <BrandIcon name="browser" />
                Open in browser
              </a>
            </div>
          </div>
          <ProductPreview />
        </section>
        <Workflow />
      </main>
      <CloudFooter appUrl={appUrl} repositoryUrl={repositoryUrl} />
    </div>
  );
}

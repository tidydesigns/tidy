import type { Metadata } from "next";
import { CloudFooter } from "../components/brand/cloud-footer";
import { CloudArtwork } from "../components/brand/cloud-artwork";
import { CloudAtmosphere } from "../components/brand/cloud-atmosphere";
import { BrandIcon } from "../components/brand/brand-icon";
import { ProductPreview } from "../components/machine/product-preview";
import { Workflow } from "../components/machine/workflow";
import { HomeEditorial } from "../components/editorial/home-editorial";
import { appUrl, downloadUrl, repositoryUrl } from "../lib/site-links";
import { pageMetadata } from "../lib/page-metadata";
import styles from "../components/machine/machine.module.css";

export const metadata: Metadata = pageMetadata(
  "/",
  "Tidy: Design and build in the same app",
  "A full design canvas in your browser, and a desktop app with your canvas, code and coding agents together. Open source under the Apache License 2.0.",
);

export default function HomePage() {
  return (
    <div className={styles.site}>
      <main id="main-content" tabIndex={-1} aria-label="Tidy product overview">
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
              Design and build
              <br />
              in the same app.
            </h1>
            <p className={styles.heroDescription}>
              A full design canvas in your browser.
              <br className={styles.desktopBreak} /> Your canvas, code and coding agents together on
              your Mac.
            </p>
            <div className={styles.heroActions}>
              <a className="button button-primary" href={downloadUrl}>
                <BrandIcon name="apple" />
                Download for macOS <span className={styles.betaLabel}>Beta</span>
              </a>
              <a className="button button-secondary" href={appUrl}>
                <BrandIcon name="browser" />
                Open Tidy
              </a>
            </div>
            <p className={styles.openSourceNote}>
              Open source. <a href={`${repositoryUrl}/blob/main/LICENSE`}>Apache 2.0 licensed.</a>
            </p>
          </div>
          <ProductPreview />
        </section>
        <Workflow />
        <HomeEditorial />
      </main>
      <CloudFooter appUrl={appUrl} repositoryUrl={repositoryUrl} />
    </div>
  );
}

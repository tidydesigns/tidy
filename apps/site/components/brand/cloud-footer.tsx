import Link from "next/link";
import { CloudArtwork } from "./cloud-artwork";
import { CloudAtmosphere } from "./cloud-atmosphere";
import { BrandIcon } from "./brand-icon";
import { documentationUrl } from "../../lib/site-links";
import { AnimatedWordmark } from "./animated-wordmark";
import styles from "./cloud-footer.module.css";

export function CloudFooter({
  appUrl,
  repositoryUrl = "https://github.com/tidydesigns/tidy",
}: {
  appUrl: string;
  repositoryUrl?: string;
}) {
  return (
    <footer id="cloud-footer" className={styles.footer}>
      <CloudAtmosphere />
      <div className={styles.blockLeft} aria-hidden="true">
        <CloudArtwork name="cloud-coral" sizes="(max-width: 640px) 42vw, 420px" />
      </div>
      <div className={styles.blockRight} aria-hidden="true">
        <CloudArtwork name="cloud-spectrum" sizes="(max-width: 640px) 49.56vw, 461px" />
      </div>
      <div className={styles.invitation}>
        <h2>
          Let’s build
          <br />
          something good.
        </h2>
        <a className={styles.action} href={appUrl}>
          Open Tidy
        </a>
      </div>
      <div className={styles.wordmark}>
        <AnimatedWordmark />
      </div>
      <div className={styles.bottom}>
        <span>© 2026 Tidy</span>
        <nav aria-label="Footer">
          <a href={repositoryUrl}>
            <BrandIcon name="github" />
            GitHub
          </a>
          <a href={documentationUrl}>Documentation</a>
          <Link href="/changelog">Changelog</Link>
          <Link href="/blog">Blog</Link>
          <Link href="/about">About</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
      </div>
    </footer>
  );
}

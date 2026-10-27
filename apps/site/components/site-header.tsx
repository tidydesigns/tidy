import Link from "next/link";
import { ThemeSwitch } from "./brand/theme-switch";
import { BrandIcon } from "./brand/brand-icon";
import { appUrl, repositoryUrl } from "../lib/site-links";

export function SiteHeader({
  currentPage,
  marketing = false,
}: {
  currentPage?: "changelog";
  marketing?: boolean;
}) {
  return (
    <header className={`header${marketing ? " marketing-header" : ""}`}>
      <Link className="tidy-logo" href="/" aria-label="Tidy home">
        Tidy
      </Link>
      <nav className="header-nav" aria-label="Main navigation">
        <Link className="header-link product-link" href="/#product">
          Product
        </Link>
        <Link
          className="header-link"
          href="/changelog"
          aria-current={currentPage === "changelog" ? "page" : undefined}
        >
          Changelog
        </Link>
        <a className="header-link github-link" href={repositoryUrl}>
          <BrandIcon name="github" />
          GitHub
        </a>
      </nav>
      <div className="header-actions">
        <ThemeSwitch />
        <a className="button button-primary header-cta" href={appUrl}>
          Get Tidy
        </a>
      </div>
    </header>
  );
}

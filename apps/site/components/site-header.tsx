"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { ThemeSwitch } from "./brand/theme-switch";
import { BrandIcon } from "./brand/brand-icon";
import { appUrl, repositoryUrl } from "../lib/site-links";

const mobileNavigationQuery = "(max-width: 900px)";
function subscribeViewport(callback: () => void) {
  const media = window.matchMedia(mobileNavigationQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
function mobileSnapshot() {
  return window.matchMedia(mobileNavigationQuery).matches;
}

function HeaderLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="header-nav" aria-label="Main navigation">
      <Link
        className="header-link product-link"
        href="/#product"
        onClick={onNavigate}
        data-select-initial
      >
        Product
      </Link>
      <Link
        className="header-link"
        href="/changelog"
        aria-current={pathname === "/changelog" ? "page" : undefined}
        onClick={onNavigate}
      >
        Changelog
      </Link>
      <Link
        className="header-link"
        href="/blog"
        aria-current={pathname === "/blog" || pathname.startsWith("/blog/") ? "page" : undefined}
        onClick={onNavigate}
      >
        Blog
      </Link>
      <Link
        className="header-link"
        href="/about"
        aria-current={pathname === "/about" ? "page" : undefined}
        onClick={onNavigate}
      >
        About
      </Link>
      <a className="header-link github-link" href={repositoryUrl} onClick={onNavigate}>
        <BrandIcon name="github" />
        GitHub
      </a>
    </nav>
  );
}

function HeaderActions({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="header-actions">
      <div className="header-appearance">
        <span className="header-appearance-label">Appearance</span>
        <ThemeSwitch />
      </div>
      <a className="button button-primary header-cta" href={appUrl} onClick={onNavigate}>
        Open Tidy
      </a>
    </div>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  const shell = useRef<HTMLDivElement>(null);
  const mobile = useSyncExternalStore(subscribeViewport, mobileSnapshot, () => false);

  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    const header = element.querySelector<HTMLElement>(".header")!;
    const surface = element.querySelector<HTMLElement>(".header-surface")!;
    const backdrop = [...element.querySelectorAll<HTMLElement>(".site-header-backdrop > *")];
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let lastProgress = -1;

    function paint() {
      frame = 0;
      const distance = Math.min(1, Math.max(0, window.scrollY) / 160);
      const progress = reduced.matches ? 1 : distance * distance * (3 - 2 * distance);
      if (progress === lastProgress) return;
      lastProgress = progress;
      // Animate each blur layer directly: opacity on their parent would prevent
      // backdrop-filter from sampling the page underneath during the crossfade.
      for (const layer of backdrop) layer.style.opacity = String(1 - progress);
      surface.style.opacity = String(progress);
      header.style.transform = reduced.matches ? "none" : `translateY(${4 * progress}px)`;
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(paint);
    }
    function onPreference() {
      lastProgress = -1;
      paint();
    }
    // Keep enlarged text in flow without changing layout during the transition.
    const resize = new ResizeObserver(() => {
      const height = `${element!.offsetHeight}px`;
      const root = document.documentElement;
      if (root.style.getPropertyValue("--site-header-height") !== height) {
        root.style.setProperty("--site-header-height", height);
      }
    });
    resize.observe(element);
    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    reduced.addEventListener("change", onPreference);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("scroll", onScroll);
      reduced.removeEventListener("change", onPreference);
    };
  }, []);

  return (
    <div ref={shell} className="site-header-shell">
      <div className="site-header-backdrop" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <div className="header-tint" />
      </div>
      <header className="header" aria-label="Tidy website">
        <div className="header-surface" aria-hidden="true" />
        <Link className="tidy-logo" href="/" aria-label="Tidy home">
          Tidy
        </Link>
        <div className="header-desktop">
          <HeaderLinks pathname={pathname} />
          <HeaderActions />
        </div>
        <SelectMenu
          className="mobile-navigation"
          triggerClassName="mobile-navigation-trigger"
          menuClassName="mobile-navigation-panel"
          label="Navigation menu"
          value=""
          options={[]}
          onChange={() => {}}
          actionMenu
          disabled={!mobile}
          align="end"
          maxMenuHeight={400}
          triggerContent={
            <>
              <BrandIcon className="navigation-open-icon" name="menu" width="24" height="24" />
              <BrandIcon className="navigation-close-icon" name="close" width="24" height="24" />
            </>
          }
          menuContent={(close) => (
            <>
              <HeaderLinks pathname={pathname} onNavigate={close} />
              <HeaderActions onNavigate={close} />
            </>
          )}
        />
      </header>
    </div>
  );
}

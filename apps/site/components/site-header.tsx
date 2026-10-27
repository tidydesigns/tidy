"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { ThemeSwitch } from "./brand/theme-switch";
import { BrandIcon } from "./brand/brand-icon";
import { appUrl, repositoryUrl } from "../lib/site-links";

export function SiteHeader() {
  const pathname = usePathname();
  const shell = useRef<HTMLDivElement>(null);

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
      const progress = distance * distance * (3 - 2 * distance);
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
      <header className="header">
        <div className="header-surface" aria-hidden="true" />
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
            aria-current={pathname === "/changelog" ? "page" : undefined}
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
    </div>
  );
}

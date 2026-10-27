"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { ThemeSwitch } from "./brand/theme-switch";
import { BrandIcon } from "./brand/brand-icon";
import { appUrl, repositoryUrl } from "../lib/site-links";

const scrollKeys = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

export function SiteHeader() {
  const pathname = usePathname();
  const shell = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    let raised = window.scrollY > 24;

    function attribute(name: string, value: boolean) {
      const next = String(value);
      if (element!.getAttribute(name) !== next) element!.setAttribute(name, next);
    }
    function onScroll() {
      // Hysteresis prevents the glass treatment flickering near the top.
      const next = raised ? window.scrollY > 8 : window.scrollY > 48;
      if (next === raised) return;
      raised = next;
      attribute("data-raised", raised);
    }
    function onKeyboard(event: KeyboardEvent) {
      if (scrollKeys.has(event.key)) attribute("data-keyboard", true);
    }
    function onPointer() {
      attribute("data-keyboard", false);
    }
    // The header stays in flow. Measuring it only on resize keeps enlarged text
    // clear of content without changing page layout during the floating transition.
    const resize = new ResizeObserver(() => {
      const height = `${element!.offsetHeight}px`;
      const root = document.documentElement;
      if (root.style.getPropertyValue("--site-header-height") !== height) {
        root.style.setProperty("--site-header-height", height);
      }
    });
    resize.observe(element);
    attribute("data-raised", raised);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKeyboard);
    window.addEventListener("pointerdown", onPointer, { passive: true });
    window.addEventListener("wheel", onPointer, { passive: true });
    window.addEventListener("touchstart", onPointer, { passive: true });
    return () => {
      resize.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKeyboard);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("wheel", onPointer);
      window.removeEventListener("touchstart", onPointer);
    };
  }, []);

  return (
    <div ref={shell} className="site-header-shell" data-raised="false" data-keyboard="false">
      <header className="header">
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

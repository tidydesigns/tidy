"use client";

import NextLink, { useLinkStatus } from "next/link";
import { useState, type ComponentProps } from "react";

function NavigationPending() {
  const { pending } = useLinkStatus();
  return (
    <span
      data-navigation-pending={pending || undefined}
      role="status"
      aria-label={pending ? "Opening page" : undefined}
      className="sr-only"
    >
      {pending ? "Opening page…" : null}
    </span>
  );
}

// Preserve Next's prefetching, modifier clicks and history. A pending link dims
// without shifting its contents if the next route's shell is not available yet.
export function NavigationLink({
  children,
  className = "",
  prefetchOnIntent = false,
  onMouseEnter,
  onFocus,
  onTouchStart,
  ...props
}: ComponentProps<typeof NextLink> & { prefetchOnIntent?: boolean }) {
  const [intentHref, setIntentHref] = useState<string | null>(null);
  function warmDestination() {
    const href = props.href;
    if (
      prefetchOnIntent &&
      typeof href === "string" &&
      href.startsWith("/") &&
      !href.startsWith("//")
    ) {
      setIntentHref(href);
    }
  }
  return (
    <NextLink
      {...props}
      prefetch={prefetchOnIntent && intentHref === props.href ? true : props.prefetch}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        warmDestination();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        warmDestination();
      }}
      onTouchStart={(event) => {
        onTouchStart?.(event);
        warmDestination();
      }}
      className={`${className} has-[[data-navigation-pending=true]]:opacity-60`}
    >
      {children}
      <NavigationPending />
    </NextLink>
  );
}

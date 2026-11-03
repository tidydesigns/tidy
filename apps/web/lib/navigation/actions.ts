"use server";

import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";

const unsafePathPattern = /[\\\x00-\x1f\x7f]/;

// Better Auth changes cookies through route handlers, outside Next's Server
// Actions. Invalidate the old session's prefetched pages and persistent layout
// before navigating; push/replace followed by refresh can race the transition.
// Client callers must return/await this in a form Action or useTransition so
// Next's redirect rejection reaches its RedirectBoundary instead of the browser.
export async function navigateWithFreshSession(href: string, replace = true): Promise<never> {
  if (
    typeof href !== "string" ||
    !href.startsWith("/") ||
    href.startsWith("//") ||
    unsafePathPattern.test(href)
  ) {
    throw new Error("Invalid navigation destination.");
  }
  revalidatePath("/", "layout");
  redirect(href === "/" ? "/files" : href, replace ? RedirectType.replace : RedirectType.push);
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";

// Better Auth changes cookies through route handlers, outside Next's Server
// Actions. Invalidate the old session's prefetched pages and persistent layout
// before navigating; push/replace followed by refresh can race the transition.
export async function navigateWithFreshSession(href: string, replace = true): Promise<void> {
  if (
    typeof href !== "string" ||
    !href.startsWith("/") ||
    href.startsWith("//") ||
    /[\\\x00-\x1f\x7f]/.test(href)
  ) {
    throw new Error("Invalid navigation destination.");
  }
  revalidatePath("/", "layout");
  redirect(href === "/" ? "/files" : href, replace ? RedirectType.replace : RedirectType.push);
}

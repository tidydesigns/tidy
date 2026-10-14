export const privacyPolicyUrl = new URL(
  "/privacy",
  process.env.NEXT_PUBLIC_SITE_URL || "https://tidydesign.co",
).href;

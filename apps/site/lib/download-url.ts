// A permanent endpoint; release selection happens at click time, not during the site build.
export const downloadUrl = process.env.NEXT_PUBLIC_DOWNLOAD_URL || "/download/mac";

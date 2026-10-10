const siteHost = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://tidydesign.co").host;

export function SiteFooter() {
  return (
    <footer className="footer">
      <span>© 2026 Tidy</span>
      <span>{siteHost}</span>
    </footer>
  );
}

import Link from "next/link";
import { getPosts } from "../lib/blog";

const siteHost = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://tidydesign.co").host;

export async function SiteFooter() {
  const showBlog = (await getPosts()).length > 0;
  return (
    <footer className="footer">
      <span>© 2026 Tidy</span>
      <div className="footer-links">
        {showBlog && <Link href="/blog">Blog</Link>}
        <Link href="/about">About</Link>
        <Link href="/privacy">Privacy</Link>
        <span>{siteHost}</span>
      </div>
    </footer>
  );
}

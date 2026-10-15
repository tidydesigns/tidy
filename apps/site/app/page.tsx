import type { Metadata } from "next";
import Image from "next/image";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";

const loginUrl = new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? "https://app.tidydesign.co")
  .href;

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <div className="page">
      <SiteHeader />

      <main className="content">
        <h1>Tidy is a product canvas for designers, engineers, and agents.</h1>
        <p>
          It brings design and engineering into one workspace. People work directly on interfaces,
          while agents can read, create, and edit designs through MCP. Tidy can be self-hosted and
          extended with custom tools.
        </p>
        <a className="login-link" href={loginUrl}>
          Log in to Tidy
        </a>
        <a
          className="product-hunt-badge"
          href="https://www.producthunt.com/products/tidy-design?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-tidy-design"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            alt="Tidy Design - Open Source Paper / Figma Alternative | Product Hunt"
            width={250}
            height={54}
            src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1279519&theme=light&t=1792105547368"
            unoptimized
          />
        </a>
      </main>

      <SiteFooter />
    </div>
  );
}

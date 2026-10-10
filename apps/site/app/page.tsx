import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";

const loginUrl = new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? "https://app.tidydesign.co")
  .href;

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
      </main>

      <SiteFooter />
    </div>
  );
}

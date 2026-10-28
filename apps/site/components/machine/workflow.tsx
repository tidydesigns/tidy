import { BrandIcon } from "../brand/brand-icon";
import { repositoryUrl } from "../../lib/site-links";
import { ProductCaptureImage } from "./product-capture";
import styles from "./workflow.module.css";

type Product = "canvas" | "desktop";
function ProductCapture({
  product,
  alt,
  caption,
}: {
  product: Product;
  alt: string;
  caption: string;
}) {
  return (
    <figure className={styles.capture}>
      <div className={styles.captureWindow}>
        <ProductCaptureImage product={product} alt={alt} />
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function CompatibleAgents() {
  return (
    <ul className={styles.agents} aria-label="Compatible coding agents">
      <li>
        <span className={styles.claude} aria-hidden="true" />
        Claude Code
      </li>
      <li>
        <span className={styles.codex} aria-hidden="true" />
        Codex
      </li>
      <li>
        <span className={styles.opencode} aria-hidden="true" />
        OpenCode
      </li>
    </ul>
  );
}

export function Workflow() {
  return (
    <section id="product" className={styles.features} aria-label="Design and build with Tidy">
      <article className={styles.feature}>
        <div className={styles.sectionIntro}>
          <h2>
            A full design canvas.
            <br />
            In your browser.
          </h2>
          <div className={styles.copy}>
            <p>
              Design interfaces with text, vectors, auto layout, components and variables. Share a
              workspace and work on the same design files with your team.
            </p>
            <p>
              Connect your coding agent through MCP to read and edit those files from your coding
              workflow.
            </p>
            <CompatibleAgents />
          </div>
        </div>
        <ProductCapture
          product="canvas"
          alt="Tidy’s running canvas with an editable landing page, layer list and typography inspector."
          caption="The Tidy canvas, shown with an example design file."
        />
      </article>

      <article className={styles.feature}>
        <div className={styles.sectionIntro}>
          <h2>
            Take a design
            <br />
            to working code.
          </h2>
          <div className={styles.copy}>
            <p>
              Open your code project in the desktop app. Attach a design to a Claude Code or Codex
              thread and ask it to build the interface or change the implementation.
            </p>
            <p>
              Make a visual change on the canvas, then ask the agent to update the code. Designers
              can build their ideas, and engineers can work directly on the design.
            </p>
          </div>
        </div>
        <ProductCapture
          product="desktop"
          alt="The real Tidy desktop interface with an agent thread, design preview, tool output and changed files."
          caption="Tidy desktop, shown with an example project and simulated agent activity."
        />
        <div className={styles.syncNote}>
          <BrandIcon name="cloud" width="24" height="24" />
          <div>
            <h3>Your local designs, connected to your workspace.</h3>
            <p>
              Cloud sync saves edits locally and syncs them in the background. Keep editing offline;
              your changes sync to your Tidy workspace when you reconnect.
            </p>
          </div>
        </div>
      </article>

      <section className={styles.openSource} aria-labelledby="open-source-title">
        <div>
          <h2 id="open-source-title">
            Open source.
            <br />
            <a href={`${repositoryUrl}/blob/main/LICENSE`}>Apache 2.0.</a>
          </h2>
        </div>
        <div className={styles.copy}>
          <p>
            Use Tidy, change the code, or run it on your own infrastructure. The web app, desktop
            app and shared canvas are in the repository.
          </p>
          <p>Star the project, fork it for your own workflow, or contribute improvements.</p>
          <div className={styles.sourceLinks}>
            <a href={repositoryUrl}>
              <BrandIcon name="github" />
              <span>Star on GitHub</span>
              <span aria-hidden="true">↗</span>
            </a>
            <a href={`${repositoryUrl}/fork`}>
              <span>Fork the project</span>
              <span aria-hidden="true">↗</span>
            </a>
            <a href={`${repositoryUrl}/blob/main/CONTRIBUTING.md`}>
              <span>Contribute</span>
              <span aria-hidden="true">↗</span>
            </a>
            <a href={`${repositoryUrl}#self-hosting`}>
              <span>Self-host Tidy</span>
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </section>
    </section>
  );
}

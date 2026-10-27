import { CloudArtwork } from "../brand/cloud-artwork";
import styles from "./machine.module.css";

/** An illustrative workspace, deliberately free of pretend interactive controls. */
export function ProductPreview() {
  return (
    <figure className={styles.productPreview}>
      <div className={styles.workspace} aria-hidden="true">
        <div className={styles.windowBar}>
          <span>Tidy / form website</span>
          <span>Local project</span>
        </div>
        <div className={styles.workspaceBody}>
          <div className={styles.sidebar}>
            <strong>form / Website</strong>
            <div className={styles.workspaceTabs}>
              <span>⌑ &nbsp;Design</span>
              <span>{"{}"} &nbsp;Code</span>
            </div>
            <span className={styles.micro}>Design files</span>
            <span>Landing page</span>
            <span>Components</span>
            <span>Mobile</span>
            <span className={styles.micro}>Coding threads</span>
            <span>Build the landing page</span>
            <span>Refine the spacing</span>
          </div>
          <div className={styles.canvas}>
            <div className={styles.canvasBar}>
              <span>Landing / Desktop</span>
              <span>100%</span>
            </div>
            <div className={styles.samplePage}>
              <div className={styles.sampleNav}>
                <strong>form</strong>
                <span>A place for good ideas.</span>
              </div>
              <div className={styles.sampleTitle}>
                Make room
                <br />
                for good ideas.
              </div>
              <p>
                A calmer place to collect, shape and share
                <br />
                the things you want to make.
              </p>
              <span className={styles.sampleButton}>Explore the collection</span>
              <CloudArtwork name="cloud-spectrum" sizes="(max-width: 700px) 80vw, 620px" />
            </div>
            <div className={styles.canvasBar}>
              <span>Frame / Hero</span>
              <span>Shared with agent ↗</span>
            </div>
          </div>
          <div className={styles.agentPanel}>
            <div className={styles.agentHeader}>
              <span>Claude Code</span>
              <span>Complete</span>
            </div>
            <span className={styles.micro}>Attached design</span>
            <span>Landing page.tidy</span>
            <p className={styles.agentPrompt}>
              Build this design in the project.
              <br />
              Keep the type and spacing.
            </p>
            <p>I used the attached design as context and implemented the page.</p>
            <div className={styles.changedFiles}>
              <strong>3 files changed</strong>
              <span>app/page.tsx</span>
              <span>components/hero.tsx</span>
              <span>app/globals.css</span>
            </div>
            <span className={styles.checks}>✓ &nbsp;Checks passed</span>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        Example workspace showing editable design files, a live canvas and a coding agent
        implementing the attached design in the same project.
      </figcaption>
    </figure>
  );
}

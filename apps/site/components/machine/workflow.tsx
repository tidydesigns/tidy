import { BrandIcon } from "../brand/brand-icon";
import { CloudArtwork } from "../brand/cloud-artwork";
import styles from "./workflow.module.css";

function DesignGraphic() {
  return (
    <div className={`${styles.graphic} ${styles.designGraphic}`} aria-hidden="true">
      <div className={styles.appBar}>
        <span>
          <BrandIcon name="frame" /> Form — Landing page
        </span>
        <span>
          Design <span className={styles.inactive}>Inspect</span>
        </span>
      </div>
      <div className={styles.editorBody}>
        <div className={styles.layers}>
          <span className={styles.panelTitle}>Layers</span>
          <span>
            <BrandIcon name="frame" /> Landing / Desktop
          </span>
          <span className={styles.layerChild}>Navigation</span>
          <span className={styles.selectedLayer}>
            T <span>Headline</span>
          </span>
          <span className={styles.layerChild}>Description</span>
          <span className={styles.layerChild}>Cloud artwork</span>
        </div>
        <div className={styles.designStage}>
          <div className={styles.artboard}>
            <span className={styles.formLogo}>form</span>
            <div className={styles.selectedText}>
              Make room
              <br />
              for good ideas.
              <i />
              <i />
              <i />
              <i />
            </div>
            <span className={styles.artboardCopy}>A little more room to think.</span>
            <CloudArtwork name="cloud-coral" sizes="(max-width: 700px) 180px, 260px" />
          </div>
        </div>
        <div className={styles.inspector}>
          <span className={styles.panelTitle}>Typography</span>
          <span className={styles.property}>Instrument Sans</span>
          <div className={styles.propertyPair}>
            <span>Medium</span>
            <span>76</span>
          </div>
          <span className={styles.panelTitle}>Fill</span>
          <span className={styles.property}>
            <i className={styles.swatch} /> 292929
          </span>
          <span className={styles.panelTitle}>Variable</span>
          <span className={styles.token}>text / primary</span>
        </div>
      </div>
    </div>
  );
}

function SyncGraphic() {
  return (
    <div className={`${styles.graphic} ${styles.syncGraphic}`} aria-hidden="true">
      <div className={styles.sharedFile}>
        <BrandIcon name="cloud" /> Form / Landing page
      </div>
      <div className={styles.syncBranches}>
        <i />
        <span>↔</span>
        <i />
      </div>
      <div className={styles.devices}>
        <div className={styles.device}>
          <div className={styles.deviceBar}>
            <BrandIcon name="computer" />
            <span>Desktop</span>
          </div>
          <div className={styles.devicePage}>
            <b>form</b>
            <span>
              Make room
              <br />
              for good ideas.
            </span>
            <CloudArtwork name="cloud-spectrum" sizes="180px" />
          </div>
          <div className={styles.deviceStatus}>
            <BrandIcon name="check" /> Saved locally
          </div>
        </div>
        <div className={styles.device}>
          <div className={styles.deviceBar}>
            <BrandIcon name="browser" />
            <span>Browser</span>
          </div>
          <div className={styles.devicePage}>
            <b>form</b>
            <span>
              Make room
              <br />
              for good ideas.
            </span>
            <CloudArtwork name="cloud-spectrum" sizes="180px" />
          </div>
          <div className={styles.deviceStatus}>
            <BrandIcon name="check" /> Synced
          </div>
        </div>
      </div>
      <div className={styles.offlineNote}>
        <span className={styles.statusDot} /> Offline edits sync when you reconnect.
      </div>
    </div>
  );
}

function AgentGraphic() {
  return (
    <div className={`${styles.graphic} ${styles.agentGraphic}`} aria-hidden="true">
      <div className={styles.connectionFile}>
        <BrandIcon name="frame" />
        <div>
          <strong>Landing page</strong>
          <span>Editable design file</span>
        </div>
      </div>
      <div className={styles.connectionLine}>
        <i />
        <span>MCP</span>
        <i />
      </div>
      <div className={styles.agentConversation}>
        <div className={styles.message}>Use this design to build the landing page.</div>
        <div className={styles.toolCall}>
          <BrandIcon name="check" />
          <span>Read design file</span>
          <span>Complete</span>
        </div>
        <div className={styles.toolCall}>
          <BrandIcon name="check" />
          <span>Update canvas</span>
          <span>Complete</span>
        </div>
      </div>
    </div>
  );
}

export function Workflow() {
  return (
    <section id="product" className={styles.features} aria-label="What you can do with Tidy">
      <article className={styles.feature}>
        <div className={styles.copy}>
          <h2>
            Design with
            <br />
            real layers.
          </h2>
          <p>
            Edit text, vectors, components and variables on the canvas. Your file stays editable
            when an agent reads or changes the design.
          </p>
          <p>Expand a live design from a thread, make a change, then return to the conversation.</p>
        </div>
        <DesignGraphic />
      </article>
      <article className={`${styles.feature} ${styles.reversed}`}>
        <div className={styles.copy}>
          <h2>
            Your files.
            <br />
            Desktop and browser.
          </h2>
          <p>
            Open your workspace’s design files on your Mac. Changes save locally and sync in the
            background.
          </p>
          <p>Keep editing offline. When you reconnect, your changes sync back to your workspace.</p>
        </div>
        <SyncGraphic />
      </article>
      <article className={styles.feature}>
        <div className={styles.copy}>
          <h2>
            Work with your
            <br />
            coding agent.
          </h2>
          <p>
            Connect your agent through MCP to read and edit design files from the conversation
            you’re already in.
          </p>
          <p>
            Use Claude Code or Codex in the desktop app to work on designs alongside your local code
            project.
          </p>
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
        </div>
        <AgentGraphic />
      </article>
    </section>
  );
}

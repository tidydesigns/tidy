import styles from "./machine.module.css";

export function Workflow() {
  return (
    <section id="product" className={styles.workflow} aria-labelledby="workflow-title">
      <div className={styles.sectionIntro}>
        <div>
          <p className={styles.eyebrow}>The development environment</p>
          <h2 id="workflow-title">
            The idea doesn’t get lost
            <br className={styles.desktopBreak} /> between tools.
          </h2>
        </div>
        <p className={styles.introCopy}>
          Design with intent.
          <br />
          Give agents context.
          <br />
          Keep your eye on the result.
        </p>
      </div>
      <div className={styles.workflowGrid}>
        <article>
          <div className={`${styles.diagram} ${styles.canvasDiagram}`} aria-hidden="true">
            <div>
              What if it
              <br />
              felt like this?
              <i />
            </div>
            <span>canvas.tidy</span>
          </div>
          <p className={styles.eyebrow}>01 / The canvas</p>
          <h3>Room to think.</h3>
          <p>Work visually with editable layers, components and tokens.</p>
        </article>
        <article>
          <div className={`${styles.diagram} ${styles.agentDiagram}`} aria-hidden="true">
            <span>Claude Code</span>
            <div>
              Use the attached design.
              <br />
              Build it in this project.
            </div>
            <span>Design context attached</span>
          </div>
          <p className={styles.eyebrow}>02 / Your coding agents</p>
          <h3>Context to build.</h3>
          <p>Keep design intent alongside the work. Bring the agents you already use.</p>
        </article>
        <article>
          <div className={`${styles.diagram} ${styles.feedbackDiagram}`} aria-hidden="true">
            <div>
              <span>Aa</span>
              <span>Aa</span>
            </div>
            <span>Design + implementation</span>
            <span>feedback → next iteration</span>
          </div>
          <p className={styles.eyebrow}>03 / The feedback loop</p>
          <h3>Details that survive.</h3>
          <p>Compare design and implementation. Refine the parts that make it yours.</p>
        </article>
      </div>
    </section>
  );
}

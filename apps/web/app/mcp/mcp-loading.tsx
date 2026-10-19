import { Skeleton } from "@/components/ui/skeleton";
import styles from "./mcp-connection.module.css";

export function McpPageHeading() {
  return (
    <>
      <h1 data-ph-public className={styles.pageTitle}>
        MCP
      </h1>
      <p data-ph-public className={styles.pageDescription}>
        Use your coding agents with your Tidy files.
      </p>
    </>
  );
}

export function McpConnectionsSkeleton() {
  return (
    <div role="status" aria-label="Loading authorized agents" data-mcp-connections-skeleton>
      <span data-ph-public className="sr-only">
        Loading authorized agents…
      </span>
      <div aria-hidden="true">
        <div className={styles.agentsHeading}>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-11 w-40" />
        </div>
        <div className={styles.agentList}>
          <div className={styles.agentRow}>
            <div className={styles.agentIdentity}>
              <Skeleton className="size-7 shrink-0" />
              <div className="min-w-0">
                <Skeleton className="h-6 w-28" />
                <Skeleton className="mt-[3px] h-[18px] w-36" />
              </div>
            </div>
            <div className={styles.agentActions}>
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-11 w-24" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function McpLoadingContent() {
  return (
    <section className={styles.connection}>
      <McpPageHeading />
      <div className={styles.content}>
        <McpConnectionsSkeleton />
      </div>
    </section>
  );
}

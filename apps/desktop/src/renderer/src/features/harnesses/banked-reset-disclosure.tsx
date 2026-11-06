import type { HarnessUsage } from "../../../../shared/contracts/harness-usage";

/** Older hosts keep provider-reported expiry details without exposing a spending action. */
export function BankedResetDisclosure({ resets }: { resets: HarnessUsage["resets"] }) {
  if (!resets || resets.availableCount === 0) return null;
  const localTime = (seconds: number) =>
    new Date(seconds * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  return (
    <details className="account-usage-section account-usage-disclosure">
      <summary>
        Banked resets<span>{resets.availableCount} available</span>
      </summary>
      <div className="account-usage-reset-list">
        {resets.items?.map((item) => (
          <div className="account-usage-line" key={item.id}>
            <span>{item.title ?? "Rate-limit reset"}</span>
            <span className="account-usage-muted">
              {item.expiresAt !== undefined && item.expiresAt !== null ? (
                <time
                  dateTime={new Date(item.expiresAt * 1000).toISOString()}
                  aria-label={`Expires ${localTime(item.expiresAt)}`}
                  title={localTime(item.expiresAt)}
                >
                  Expires{" "}
                  {new Date(item.expiresAt * 1000).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    timeZoneName: "short",
                  })}
                </time>
              ) : item.expiresAt === null ? (
                "No expiry"
              ) : (
                "Expiry not reported"
              )}
            </span>
          </div>
        ))}
        {!resets.items?.length && (
          <div className="account-usage-muted">
            Expiry details aren't reported by this connection.
          </div>
        )}
      </div>
    </details>
  );
}

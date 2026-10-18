import { useState } from "react";
import { Button } from "@tidy/ui/button";
import type { ApprovalRequest, ApprovalDecision } from "../../shared/permissions";
const labels: Record<ApprovalDecision, string> = {
  allow: "Allow once",
  "allow-session": "Allow for session",
  deny: "Deny",
};

export function ApprovalRequests({
  requests,
  onRespond,
}: {
  requests: ApprovalRequest[];
  onRespond(id: string, decision: ApprovalDecision): Promise<void>;
}) {
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<{ id: string; text: string }>();
  async function respond(id: string, decision: ApprovalDecision) {
    if (pending.includes(id)) return;
    setPending((current) => [...current, id]);
    setError(undefined);
    try {
      await onRespond(id, decision);
    } catch (value) {
      setError({
        id,
        text: value instanceof Error ? value.message : "The response could not be sent.",
      });
    } finally {
      setPending((current) => current.filter((value) => value !== id));
    }
  }
  if (!requests.length) return null;
  return (
    <div className="approval-requests" aria-label="Permission requests">
      {requests.map((request) => (
        <section key={request.id} className="approval-request" aria-label={request.title}>
          <strong>{request.title}</strong>
          <div className="approval-body">
            {request.details && <pre tabIndex={0}>{request.details}</pre>}
            {request.reason && <p>{request.reason}</p>}
            {request.shortened && <small>Request shortened</small>}
            {error?.id === request.id && (
              <p role="alert" className="thread-error">
                {error.text}
              </p>
            )}
          </div>
          <div className="approval-actions">
            {request.choices.map((decision) => (
              <Button
                key={decision}
                type="button"
                className="secondary-button"
                disabled={pending.includes(request.id)}
                onClick={() => void respond(request.id, decision)}
              >
                {decision === "allow" && request.scope === "turn"
                  ? "Allow for turn"
                  : labels[decision]}
              </Button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

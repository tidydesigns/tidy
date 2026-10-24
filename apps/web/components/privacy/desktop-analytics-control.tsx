"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
export function DesktopAnalyticsControl() {
  const [message, setMessage] = useState("");
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/privacy/desktop-analytics-link", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    })
      .then(async (response) => {
        if (response.ok) {
          const value = (await response.json()) as { linked?: boolean };
          if (active) setLinked(value.linked === true);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  async function unlink() {
    try {
      const response = await fetch("/api/privacy/desktop-analytics-link", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-tidy-privacy": "1" },
        body: JSON.stringify({ action: "unlink" }),
        signal: AbortSignal.timeout(10_000),
      });
      setMessage(
        response.ok
          ? "Account-linked product reports removed. Desktop usage remains optional on each installation."
          : "Could not remove linking. Please retry.",
      );
    } catch {
      setMessage("Could not remove linking. Please retry.");
    }
  }
  if (!linked) return null;
  return (
    <div className="space-y-2">
      <Button variant="text" onClick={() => void unlink()}>
        Unlink desktop usage and delete linked reports
      </Button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}

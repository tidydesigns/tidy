"use client";
import { useCallback } from "react";
import { useErrorNotice } from "@tidy/ui/use-error-notice";
import { useEditorHost } from "../host";

export function useEditorErrorNotice(
  operation = "user_action",
  presentation: "toast" | "inline" = "toast",
) {
  const { reportError } = useEditorHost();
  const reporter = useCallback(() => reportError(operation), [reportError, operation]);
  return useErrorNotice({ reporter, presentation });
}

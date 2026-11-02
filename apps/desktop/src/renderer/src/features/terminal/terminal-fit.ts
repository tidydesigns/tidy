import type { FitAddon, Terminal } from "ghostty-web";
import { terminalSizeLimits } from "../../../../shared/contracts/terminal";

export function fitTerminal({
  terminal,
  fit,
}: {
  terminal: Pick<Terminal, "cols" | "rows" | "resize">;
  fit: Pick<FitAddon, "proposeDimensions">;
}) {
  const size = fit.proposeDimensions();
  if (!size) return;
  const cols = Math.min(
    terminalSizeLimits.maxCols,
    Math.max(terminalSizeLimits.minCols, size.cols),
  );
  const rows = Math.min(
    terminalSizeLimits.maxRows,
    Math.max(terminalSizeLimits.minRows, size.rows),
  );
  if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
}

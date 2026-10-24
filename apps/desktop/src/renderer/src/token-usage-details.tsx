import type { TokenUsage } from "../../shared/harness-settings";

const number = (value: number) => value.toLocaleString();
export function TokenUsageDetails({ usage }: { usage: TokenUsage }) {
  return (
    <dl className="usage-statistics">
      <div>
        <dt>Input tokens</dt>
        <dd>{number(usage.inputTokens)}</dd>
      </div>
      <div>
        <dt>Cached input</dt>
        <dd>{number(usage.cachedInputTokens)}</dd>
      </div>
      <div>
        <dt>Output tokens</dt>
        <dd>{number(usage.outputTokens)}</dd>
      </div>
      {usage.costUSD !== undefined && (
        <div title="The harness's API cost estimate. This is not a subscription charge or billing statement.">
          <dt>Estimated API cost</dt>
          <dd>${usage.costUSD.toFixed(2)}</dd>
        </div>
      )}
    </dl>
  );
}

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import {
  NavigationRecoveryProvider,
  useNavigationRecovery,
} from "../../components/workspace/navigation-recovery";

// Keep failed siblings mounted after retry, as happens with a persistent error.
// A non-reactive shared budget leaves the second boundary loading indefinitely.
const retry = () => {
  const count = document.querySelector("output")!;
  count.textContent = String(Number(count.textContent) + 1);
};
function FailedSection({ name }: { name: string }) {
  const pending = useNavigationRecovery(retry);
  return <div data-section={name}>{pending ? "Retrying" : "Retry available"}</div>;
}
function Fixture() {
  const [pathname, setPathname] = useState("/mcp");
  return (
    <PathnameContext value={pathname}>
      <button onClick={() => setPathname("/settings")}>Visit settings</button>
      <NavigationRecoveryProvider>
        <FailedSection name="first" />
        <FailedSection name="second" />
      </NavigationRecoveryProvider>
    </PathnameContext>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);

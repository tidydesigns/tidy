import { TidyLogo } from "@tidy/ui/tidy-logo";

export function App() {
  return (
    <main className="workspace">
      <div className="welcome">
        <h1 aria-label="Tidy">
          <TidyLogo className="tidy-logo" />
        </h1>
        <p>Your local design workspace.</p>
      </div>
    </main>
  );
}

import { useState, type KeyboardEvent } from "react";
import { Button } from "@tidy/ui/button";
import { TidyLogo } from "@tidy/ui/tidy-logo";

const workspaces = [
  { id: "design", label: "Design", description: "Your local design workspace." },
  { id: "code", label: "Code", description: "Your local coding workspace." },
] as const;

type Workspace = (typeof workspaces)[number]["id"];

export function App() {
  const [workspace, setWorkspace] = useState<Workspace>("design");

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % workspaces.length
        : event.key === "ArrowLeft"
          ? (index - 1 + workspaces.length) % workspaces.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? workspaces.length - 1
              : -1;

    if (nextIndex === -1) return;
    event.preventDefault();
    const nextWorkspace = workspaces[nextIndex].id;
    setWorkspace(nextWorkspace);
    document.getElementById(`workspace-tab-${nextWorkspace}`)?.focus();
  }

  return (
    <div className="desktop">
      <header className="workspace-header">
        <div
          role="tablist"
          aria-label="Workspace"
          aria-orientation="horizontal"
          className="workspace-tabs"
        >
          {workspaces.map((item, index) => (
            <Button
              key={item.id}
              id={`workspace-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={workspace === item.id}
              aria-controls={`workspace-panel-${item.id}`}
              tabIndex={workspace === item.id ? 0 : -1}
              className="workspace-tab"
              onClick={() => setWorkspace(item.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </header>
      <main className="workspace">
        {workspaces.map((item) => (
          <section
            key={item.id}
            id={`workspace-panel-${item.id}`}
            role="tabpanel"
            aria-labelledby={`workspace-tab-${item.id}`}
            hidden={workspace !== item.id}
            tabIndex={0}
            className="workspace-panel"
          >
            <div className="welcome">
              <h1 aria-label="Tidy">
                <TidyLogo className="tidy-logo" />
              </h1>
              <p>{item.description}</p>
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TidyDesign } from "@tidy/design-renderer/design";
import type {
  VisualPreviewData,
  VisualPreviewState,
  VisualPreviewView,
} from "./visual-preview-types";

const data: VisualPreviewData = JSON.parse(
  document.getElementById("tidy-preview-data")!.textContent!,
);
const states: VisualPreviewState[] = ["default", "hover", "pressed", "focus", "disabled"];

function Screen({ view }: { view: VisualPreviewView }) {
  const [variant, setVariant] = useState(view.initialVariant);
  const [state, setState] = useState(view.initialState);
  const host = useRef<HTMLDivElement>(null),
    design = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({
    width: view.width,
    height: 1,
    scale: 1,
    left: 0,
    top: 0,
    padding: 0,
  });
  useLayoutEffect(() => {
    const update = () => {
      const node = design.current?.firstElementChild as HTMLElement | null;
      if (!node || !host.current) return;
      const rect = node.getBoundingClientRect(),
        wrapper = design.current!.getBoundingClientRect();
      const currentScale = wrapper.width / view.width || 1;
      const width = Math.max(1, rect.width / currentScale),
        height = Math.max(1, rect.height / currentScale);
      const left = (rect.left - wrapper.left) / currentScale,
        top = (rect.top - wrapper.top) / currentScale;
      const style = getComputedStyle(node);
      let padding = parseFloat(style.outlineWidth) || 0;
      for (const shadow of style.boxShadow.replace(/rgba?\([^)]*\)/g, "").split(",")) {
        const values = [...shadow.matchAll(/(-?[\d.]+)px/g)].map((match) => Number(match[1]));
        if (values.length >= 3 && !shadow.includes("inset"))
          padding = Math.max(
            padding,
            Math.abs(values[0]) + Math.abs(values[1]) + values[2] * 2 + (values[3] ?? 0),
          );
      }
      for (const blur of style.filter.matchAll(/blur\(([\d.]+)px\)/g))
        padding = Math.max(padding, Number(blur[1]) * 2);
      const scale = Math.min(1, host.current.clientWidth / (width + padding * 2));
      setGeometry((old) =>
        Math.abs(old.width - width) < 0.01 &&
        Math.abs(old.height - height) < 0.01 &&
        Math.abs(old.scale - scale) < 0.00001 &&
        Math.abs(old.left - left) < 0.01 &&
        Math.abs(old.top - top) < 0.01 &&
        old.padding === padding
          ? old
          : { width, height, scale, left, top, padding },
      );
    };
    const observer = new ResizeObserver(update);
    if (host.current) observer.observe(host.current);
    if (design.current?.firstElementChild) observer.observe(design.current.firstElementChild);
    void document.fonts.ready.then(update);
    update();
    return () => observer.disconnect();
  }, [variant, state, view.width]);
  return (
    <>
      <nav aria-label="Appearance" className="tidy-controls">
        {view.variants.map((option) => (
          <button key={option} aria-pressed={variant === option} onClick={() => setVariant(option)}>
            {option}
          </button>
        ))}
        {states.map((option) => (
          <button key={option} aria-pressed={state === option} onClick={() => setState(option)}>
            {option}
          </button>
        ))}
      </nav>
      <div
        ref={host}
        className="tidy-viewport"
        style={{ height: (geometry.height + geometry.padding * 2) * geometry.scale }}
      >
        <div
          ref={design}
          data-tidy-design
          style={{
            width: view.width,
            transform: `scale(${geometry.scale}) translate(${geometry.padding - geometry.left}px, ${geometry.padding - geometry.top}px)`,
            transformOrigin: "top left",
          }}
          onClickCapture={(event) => event.preventDefault()}
          onSubmitCapture={(event) => event.preventDefault()}
        >
          <TidyDesign
            document={view.document}
            rootId={view.nodeId}
            assets={data.assets}
            variant={variant}
            state={state}
            readOnly
            frameWidth={view.width}
          />
        </div>
      </div>
    </>
  );
}

function Preview() {
  const [index, setIndex] = useState(0);
  const [runtimeWarnings, setRuntimeWarnings] = useState<string[]>([]);
  useEffect(() => {
    const error = (event: Event) => {
      const image = event.target;
      if (image instanceof HTMLImageElement) {
        const message = `Image could not be decoded: ${image.alt || "unnamed image"}`;
        console.error(message);
        setRuntimeWarnings((old) => (old.includes(message) ? old : [...old, message]));
      }
    };
    document.addEventListener("error", error, true);
    const fontError = () => {
      console.error("An embedded font could not be decoded.");
      setRuntimeWarnings((old) => [...old, "An embedded font could not be decoded."]);
    };
    document.fonts.addEventListener("loadingerror", fontError);
    return () => {
      document.removeEventListener("error", error, true);
      document.fonts.removeEventListener("loadingerror", fontError);
    };
  }, []);
  return (
    <>
      {data.views.length > 1 && (
        <nav aria-label="Views" className="tidy-controls">
          {data.views.map((view, i) => (
            <button key={i} aria-pressed={index === i} onClick={() => setIndex(i)}>
              {view.label}
            </button>
          ))}
        </nav>
      )}
      <Screen key={index} view={data.views[index]} />
      <footer>Revision {data.revision}</footer>
      {(data.warnings.length > 0 || runtimeWarnings.length > 0) && (
        <details>
          <summary>Rendering warnings ({data.warnings.length + runtimeWarnings.length})</summary>
          <ul>
            {[...data.warnings, ...runtimeWarnings].map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
createRoot(document.getElementById("tidy-preview")!).render(<Preview />);

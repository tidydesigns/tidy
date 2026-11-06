import { detectType, load, render } from "pele/lazy";
import { mermaidSourceError } from "./mermaid-source";
import { diagramImage, type DiagramImage } from "./mermaid-image";
import { MAX_MERMAID_EDGES, MermaidRenderError } from "./mermaid-error";

const images = new Map<string, DiagramImage>();
let cacheBytes = 0;

function remember(key: string, image: DiagramImage) {
  const bytes = (key.length + image.url.length) * 2;
  if (bytes > 2_000_000) return;
  images.set(key, image);
  cacheBytes += bytes;
  while (images.size > 16 || cacheBytes > 2_000_000) {
    const oldest = images.entries().next().value;
    if (!oldest) break;
    images.delete(oldest[0]);
    cacheBytes -= (oldest[0].length + oldest[1].url.length) * 2;
  }
}

function cachedImage(key: string) {
  const image = images.get(key);
  if (image) {
    images.delete(key);
    images.set(key, image);
  }
  return image;
}

export async function renderMermaid({
  source,
  dark,
  signal,
}: {
  source: string;
  dark: boolean;
  signal: AbortSignal;
}): Promise<DiagramImage> {
  signal.throwIfAborted();
  const key = `${dark}:${source}`;
  const cached = cachedImage(key);
  if (cached) return cached;
  const error = mermaidSourceError(source);
  if (error) throw new Error(error);
  let type: ReturnType<typeof detectType>;
  try {
    type = detectType(source);
  } catch (error) {
    throw new MermaidRenderError(error);
  }
  await load(type);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal.throwIfAborted();
  const completed = cachedImage(key);
  if (completed) return completed;
  try {
    const { svg } = render(source, {
      fontFamily: "Arial, sans-serif",
      fontSize: 14,
      autoDirection: false,
      responsive: false,
      links: false,
      images: false,
      limit: 20_000,
      outputLimit: 1_000_000,
      maxEdges: MAX_MERMAID_EDGES,
    });
    signal.throwIfAborted();
    const image = diagramImage(svg, dark);
    remember(key, image);
    return image;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new MermaidRenderError(error);
  }
}

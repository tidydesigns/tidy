import { useEffect, useRef, useState } from "react";
import { FileListCreator } from "@tidy/editor/components/files/file-browser-ui";
import type { CloudAPI, CloudFile } from "../../shared/cloud-sync";

/** Render the creator immediately; fetch only visible avatars through native authenticated IPC. */
export function CloudCreator({
  api,
  file,
  active,
}: {
  api: CloudAPI;
  file: CloudFile;
  active: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; image: string }>();
  const key = `${file.creatorId}:${file.creatorImage}`;
  useEffect(() => {
    if (!ref.current || !active) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: "160px",
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (!active || !visible || !file.creatorId || !file.creatorImage) return;
    let current = true;
    void api
      .creatorAvatar(file.id, file.creatorId, file.creatorImage)
      .then((image) => {
        if (current && image) setLoaded({ key, image });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, active, visible, file.id, file.creatorId, file.creatorImage, key]);
  return (
    <span ref={ref}>
      <FileListCreator
        name={file.creatorName ?? ""}
        image={loaded?.key === key ? loaded.image : null}
      />
    </span>
  );
}

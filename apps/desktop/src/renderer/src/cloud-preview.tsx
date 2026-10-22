import { useEffect, useRef, useState } from "react";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { CloudAPI, CloudFile } from "../../shared/cloud-sync";

export function CloudPreview({ api, file }: { api: CloudAPI; file: CloudFile }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    void api
      .thumbnail(file.id, file.updatedAt ?? "")
      .then((value) => {
        if (current) setImage(value);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, file.id, file.updatedAt, visible]);
  return (
    <div className="cloud-file-placeholder" ref={ref} aria-hidden="true">
      {image ? <img src={image} alt="" draggable={false} /> : <Icon name="frame" size={28} />}
    </div>
  );
}

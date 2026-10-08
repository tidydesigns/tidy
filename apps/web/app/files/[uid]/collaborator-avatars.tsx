"use client";

import { useSyncExternalStore } from "react";
import Image from "next/image";
import type { PresenceStore } from "@/lib/realtime/presence-store";
import type { ConnectionState } from "./use-file-room";
export function CollaboratorAvatars({
  store,
  connection,
}: {
  store: PresenceStore;
  connection: ConnectionState;
}) {
  const peers = useSyncExternalStore(
    store.subscribe,
    store.getUsersSnapshot,
    store.getServerSnapshot,
  );
  const users = [...new Map(peers.map((peer) => [peer.userId, peer])).values()];
  return (
    <div className="flex items-center gap-1" aria-label="People in this file">
      {users.slice(0, 5).map((peer) => (
        <span
          key={peer.userId}
          title={`${peer.name}${peer.away ? " · Away" : peer.action ? ` · ${peer.action === "typing" ? "Editing text" : peer.action === "move" ? "Moving a layer" : peer.action === "resize" ? "Resizing a layer" : "In this file"}` : ""}`}
          aria-label={`${peer.name}${peer.away ? ", away" : ", in this file"}`}
          className={`flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-surface text-[10px] font-medium ${peer.away ? "opacity-45" : ""}`}
          style={{ borderColor: peer.color, color: peer.color }}
        >
          {peer.image ? (
            <Image
              src={peer.image}
              alt=""
              width={28}
              height={28}
              unoptimized
              className="h-full w-full object-cover"
            />
          ) : (
            peer.name
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0])
              .join("")
              .toUpperCase()
          )}
        </span>
      ))}
      {users.length > 5 && (
        <span
          title={users
            .slice(5)
            .map((peer) => peer.name)
            .join(", ")}
          className="text-[10px] text-secondary-ink"
        >
          +{users.length - 5}
        </span>
      )}
      {connection !== "live" && (
        <span role="status" className="text-[10px] text-secondary-ink">
          {connection === "connecting"
            ? "Connecting…"
            : connection === "reconnecting"
              ? "Reconnecting…"
              : "Live unavailable"}
        </span>
      )}
    </div>
  );
}

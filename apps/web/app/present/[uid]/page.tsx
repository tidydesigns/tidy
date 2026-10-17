import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDesignFile } from "@/lib/design/service";
import { getDocument } from "@/lib/design/document-service";
import { PrototypePlayer } from "@/components/design/prototype-player";
import type { Metadata } from "next";
import { cache } from "react";

const presentationData = cache(async (uid: string) => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const file = await getDesignFile(session.user.id, uid);
  if (!file) notFound();
  return { session, file };
});

export async function generateMetadata({ params }: PageProps<"/present/[uid]">): Promise<Metadata> {
  const { uid } = await params;
  const { file } = await presentationData(uid);
  return {
    title: `${file.name} · Presentation · Tidy`,
    description: "Preview your Tidy prototype.",
  };
}

export default async function PresentationPage({
  params,
  searchParams,
}: PageProps<"/present/[uid]">) {
  const { uid } = await params;
  const { session, file } = await presentationData(uid);
  const snapshot = await getDocument(session.user.id, uid);
  if (!snapshot) notFound();
  const query = await searchParams;
  return (
    <main className="h-dvh">
      <PrototypePlayer
        document={snapshot.content}
        revision={snapshot.revision}
        fileName={file.name}
        initialFrameId={typeof query.frame === "string" ? query.frame : undefined}
        presentationHref={`/present/${encodeURIComponent(uid)}`}
      />
    </main>
  );
}

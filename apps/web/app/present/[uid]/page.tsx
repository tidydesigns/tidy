import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDesignFile } from "@/lib/design/service";
import { getDocument } from "@/lib/design/document-service";
import { PrototypePlayer } from "@/components/design/prototype-player";

export default async function PresentationPage({
  params,
  searchParams,
}: PageProps<"/present/[uid]">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const { uid } = await params;
  const file = await getDesignFile(session.user.id, uid);
  if (!file) notFound();
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

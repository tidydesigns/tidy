import { notFound } from "next/navigation";
import { FigmaImportPreview } from "./preview";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ editor?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const params = await searchParams;
  return <FigmaImportPreview editor={params.editor === "1"} />;
}

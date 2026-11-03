import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { MacDownloadStudies } from "./studies";

export const metadata: Metadata = { title: "Mac download studies · Tidy" };

export default function MacDownloadPreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <MacDownloadStudies />;
}

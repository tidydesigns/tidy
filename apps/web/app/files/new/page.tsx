import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";

// A direct visit or pre-hydration click gets its own draft address.
export default async function NewFilePage({ searchParams }: PageProps<"/files/new">) {
  const query = await searchParams;
  const params = new URLSearchParams({ new: "1" });
  for (const key of ["folder", "organization"]) {
    if (typeof query[key] === "string") params.set(key, query[key]);
  }
  redirect(`/files/${randomUUID()}?${params}`);
}

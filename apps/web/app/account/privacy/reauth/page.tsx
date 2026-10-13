import { ReauthResult } from "./result";
export default async function ReauthPage({ searchParams }: PageProps<"/account/privacy/reauth">) {
  return <ReauthResult success={(await searchParams).result === "success"} />;
}

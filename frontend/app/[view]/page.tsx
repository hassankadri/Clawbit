import { notFound } from "next/navigation";
import { viewFromPath, viewPaths } from "@/lib/navigation";

export function generateStaticParams() {
  return Object.values(viewPaths)
    .filter((path) => path !== "/" && path !== "/projects")
    .map((path) => ({ view: path.slice(1) }));
}

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ view: string }>;
}) {
  const { view } = await params;
  if (!viewFromPath(`/${view}`)) notFound();
  // The persistent layout owns the existing interactive surfaces and chat state.
  return null;
}

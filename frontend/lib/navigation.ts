export const viewPaths = {
  chats: "/",
  projects: "/projects",
  plugins: "/tools",
  library: "/library",
  profile: "/profile",
  customize: "/personalization",
  settings: "/settings",
  help: "/help",
} as const;

/*
 * Views handled by the existing WorkspacePanel.
 * Library is intentionally excluded because it has its own
 * dedicated LibraryWorkspace component.
 */
export type AppView = Exclude<
  keyof typeof viewPaths,
  "library"
>;

export type RouteView =
  keyof typeof viewPaths;

export function viewFromPath(
  pathname: string,
): RouteView | undefined {
  return (
    Object.keys(
      viewPaths,
    ) as RouteView[]
  ).find(
    (view) =>
      viewPaths[view] === pathname,
  );
}
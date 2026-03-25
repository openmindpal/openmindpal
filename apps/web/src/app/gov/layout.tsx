import { ConsoleShell } from "@/components/shell/ConsoleShell";

/**
 * Shared layout for /gov/* routes.
 * ConsoleShell persists across sub-route navigations so only
 * the content area re-renders when the user clicks sidebar links.
 */
export default function GovLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}

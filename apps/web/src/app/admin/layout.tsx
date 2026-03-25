import { ConsoleShell } from "@/components/shell/ConsoleShell";

/**
 * Shared layout for /admin/* routes.
 * ConsoleShell persists across sub-route navigations.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}

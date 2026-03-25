import { ConsoleShell } from "@/components/shell/ConsoleShell";

export default function OrchestratorLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}

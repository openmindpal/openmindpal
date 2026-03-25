import { ConsoleShell } from "@/components/shell/ConsoleShell";

export default function RunsLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}

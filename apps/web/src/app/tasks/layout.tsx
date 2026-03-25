import { ConsoleShell } from "@/components/shell/ConsoleShell";

export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}

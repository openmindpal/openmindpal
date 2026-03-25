import { ConsoleShell } from "@/components/shell/ConsoleShell";

export default function WorkbenchLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}

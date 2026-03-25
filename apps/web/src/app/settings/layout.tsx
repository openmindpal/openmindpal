import { ConsoleShell } from "@/components/shell/ConsoleShell";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}

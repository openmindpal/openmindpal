export type CliArgs = {
  command: string;
  options: Record<string, string | boolean>;
};

export function parseCli(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const options: Record<string, string | boolean> = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) options[k] = true;
    else {
      options[k] = next;
      i++;
    }
  }
  return { command, options };
}

export function getStringOpt(opts: Record<string, string | boolean>, key: string) {
  const v = opts[key];
  return typeof v === "string" ? v : "";
}


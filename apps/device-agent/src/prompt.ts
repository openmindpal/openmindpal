import readline from "node:readline";

export async function confirmPrompt(params: { question: string; defaultNo?: boolean }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = params.defaultNo ? " [y/N]" : " [Y/n]";
  const q = params.question + suffix + " ";
  return await new Promise<boolean>((resolve) => {
    rl.question(q, (answer) => {
      rl.close();
      const a = String(answer ?? "").trim().toLowerCase();
      if (!a) resolve(!params.defaultNo);
      else resolve(a === "y" || a === "yes");
    });
  });
}


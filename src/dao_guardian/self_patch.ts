import { Command } from "commander";
import path from "path";
import { promises as fs } from "fs";

async function main() {
  const program = new Command();
  program
    .option("--prompt-file <path>")
    .requiredOption("--worktree <path>");
  program.parse(process.argv);
  const opts = program.opts() as { promptFile?: string; worktree: string };
  const worktree = path.resolve(opts.worktree);
  const readme = path.join(worktree, "README.md");
  try {
    await fs.access(readme);
  } catch {
    return;
  }
  const marker = "\n## 自主进化心跳\n";
  const now = new Date().toISOString();
  const line = `- 心跳时间: ${now}\n`;
  const text = await fs.readFile(readme, "utf-8");
  const updated = text.includes(marker) ? text + line : text + marker + line;
  await fs.writeFile(readme, updated, "utf-8");
}

main();

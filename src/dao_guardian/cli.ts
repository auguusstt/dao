import { Command } from "commander";
import path from "path";
import { DaoEvolver, printStatus } from "./evolve.js";
import { mainPredict } from "./main.js";
import { syncDependencies } from "../common/sync.js";
import { logger } from "../common/logger.js";

const program = new Command();
program.name("dao-cli").description("DAO 统一入口：默认执行 evolve，可用子命令切换");

program
  .argument("[default]", "默认运行自主进化循环", "evolve")
  .option("--cycles <n>", "运行周期数", "999999")
  .option("--sleep <sec>", "每个周期睡眠秒数", "5.0")
  .option("--root <path>", "项目根目录", ".")
  .action(async (_default: string, opts: any) => {
    const root = path.resolve(String(opts.root ?? "."));
    const cycles = Number(opts.cycles ?? 999999);
    const sleep = Number(opts.sleep ?? 5.0);
    const evolver = new DaoEvolver(root);
    await evolver.run(cycles, sleep);
  });

program
  .command("predict")
  .option("--cycles <n>", "运行周期数", "999999")
  .option("--sleep <sec>", "每个周期睡眠秒数", "5.0")
  .option("--root <path>", "项目根目录", ".")
  .action(async (opts: any) => {
    await mainPredict({ cycles: Number(opts.cycles ?? 999999), sleep: Number(opts.sleep ?? 5.0), root: String(opts.root ?? ".") });
  });

program
  .command("status")
  .option("--root <path>", "项目根目录", ".")
  .option("--tail <n>", "最近日志条数", "8")
  .action(async (opts: any) => {
    await printStatus(String(opts.root ?? "."), Number(opts.tail ?? 8));
  });

program
  .command("sync")
  .action(async (opts: any) => {
    const log = logger.withTag("sync");
    syncDependencies().catch(err => {
        log.error(`同步失败: ${err.message}`);
        process.exit(1);
    });

  });




program.parseAsync(process.argv);

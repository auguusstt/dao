import path from "path";
import { promises as fs } from "fs";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { readJson, writeJson, appendJsonl, nowIso } from "../common/fs.js";
import chalk from "chalk";
import { setupLogger } from "./logging_utils.js";

export type PlanResult = {
  thought: string;
  next_objective: string;
  next_actions: string[];
  roadmap_update?: string;
};

export class DaoPlanner {
  root: string;
  agentsPath: string;
  roadmapPath: string;
  logsDir: string;
  stateDir: string;
  logger = setupLogger("dao.planner");
  private _currentProc: ChildProcess | null = null;

  constructor(root: string) {
    this.root = root;
    this.agentsPath = path.join(root, "AGENTS.md");
    this.roadmapPath = path.join(root, "ROADMAP.md");
    this.logsDir = path.join(root, "logs");
    this.stateDir = path.join(root, "state");
  }

  cleanup() {
    if (this._currentProc && this._currentProc.pid) {
      try {
        process.kill(-this._currentProc.pid, "SIGKILL");
      } catch (e) {
        try { this._currentProc.kill("SIGKILL"); } catch {}
      }
      this._currentProc = null;
    }
  }

  async plan(
    tool: { name: string; run_cmd: string },
    onLog?: (msg: string) => void
  ): Promise<PlanResult | null> {
    // 这里我们不再使用 onLog 封装，而是直接操作 stdout 保证“纯转发”
    
    const agents = await this._safeRead(this.agentsPath);
    const roadmap = await this._safeRead(this.roadmapPath);
    const recentEvents = await this._getRecentEvents(15);
    const eventSummary = this._summarizeEvents(recentEvents);

    const failureModesStr = Object.entries(eventSummary.commonFailureModes)
      .map(([mode, count]) => `   - ${mode}: ${count} 次`)
      .join("\n") || "   无显著失败模式";

    const prompt = `你是本项目的"大脑" (Planner Agent)。你的任务是分析当前进化状态，并规划接下来的具体目标。

### 1. 宪法 (AGENTS.md)
${agents}

### 2. 当前路线图 (ROADMAP.md)
${roadmap}

### 3. 执行统计
- 总周期：${eventSummary.totalCycles}
- 成功率：${(eventSummary.successRate * 100).toFixed(1)}%
- 连续失败：${eventSummary.consecutiveFailures}

### 4. 失败模式
${failureModesStr}

请直接输出 JSON，包含 thought, next_objective, next_actions。`;

    const tmpPromptFile = path.join(this.stateDir, "last_planner_prompt.txt");
    await fs.writeFile(tmpPromptFile, prompt, "utf-8");

    let cmd = tool.run_cmd;
    const replacements: Record<string, string> = { prompt_file: tmpPromptFile };
    for (const [k, v] of Object.entries(replacements)) cmd = cmd.split(`{${k}}`).join(v);

    process.stdout.write(chalk.blueBright(`\n[Planner] 启动原始转发模式执行: ${cmd}\n`));
    
    // 环境变量增加强制刷新输出的标志
    const env = { 
      ...process.env, 
      FORCE_COLOR: "1", 
      PYTHONUNBUFFERED: "1",
      NODE_ENV: "production" 
    };

    const proc = spawn("sh", ["-c", cmd], { 
      cwd: this.root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
    this._currentProc = proc;

    let output = "";
    let stderr = "";

    // 真正的“纯转发”：不分行，不解析，收到什么字节就吐出什么字节
    proc.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      output += s;
      process.stdout.write(s);
    });

    proc.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(chalk.red.dim(s));
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", (code) => {
        this._currentProc = null;
        resolve(code ?? 0);
      });
      proc.on("error", () => {
        this._currentProc = null;
        resolve(1);
      });
    });

    process.stdout.write(chalk.blueBright(`\n[Planner] 执行结束 (Exit: ${exitCode})，正在解析结果...\n`));

    return this._parseFinalResult(output);
  }

  private _parseFinalResult(output: string): PlanResult | null {
    // 依然保持强大的解析逻辑，但只在进程结束后运行一次
    const lines = output.split("\n").filter(l => l.trim());
    for (const line of lines.reverse()) {
      try {
        const obj = JSON.parse(line);
        if (obj.next_objective && obj.next_actions) return obj as PlanResult;
        if (obj.type === "assistant") {
          const content = obj.message?.content;
          const txt = Array.isArray(content) ? content.find((c: any) => c.type === "text")?.text : null;
          if (txt) {
            const jsonMatch = txt.match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
          }
        }
      } catch {}
    }
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch {}
    }
    return null;
  }

  private async _safeRead(p: string): Promise<string> {
    try { return await fs.readFile(p, "utf-8"); } catch { return ""; }
  }

  private async _getRecentEvents(n: number): Promise<any[]> {
    const p = path.join(this.logsDir, "evolution_events.jsonl");
    try {
      const data = await fs.readFile(p, "utf-8");
      return data.split("\n").filter(Boolean).slice(-n).map(line => JSON.parse(line));
    } catch { return []; }
  }

  private _summarizeEvents(events: any[]): any {
    const total = events.length;
    if (total === 0) return { totalCycles: 0, successRate: 0, consecutiveFailures: 0, commonFailureModes: {} };
    const successCount = events.filter(e => e.status === "PROMOTED").length;
    let consecutiveFailures = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].status === "FAIL") consecutiveFailures++; else break;
    }
    const modes: Record<string, number> = {};
    for (const e of events) {
      if (e.status === "FAIL" && e.reason) {
        const m = e.reason.includes("timeout") ? "timeout" : (e.reason.includes("校验") ? "build_fail" : "other");
        modes[m] = (modes[m] || 0) + 1;
      }
    }
    return { totalCycles: total, successRate: successCount / total, consecutiveFailures, commonFailureModes: modes };
  }
}

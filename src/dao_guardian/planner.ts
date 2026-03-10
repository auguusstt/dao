import path from "path";
import { promises as fs } from "fs";
import { spawnSync } from "child_process";
import { readJson, writeJson, appendJsonl, nowIso } from "../common/fs.js";
import chalk from "chalk";
import { setupLogger } from "./logging_utils.js";

export type PlanResult = {
  thought: string;
  next_objective: string;
  next_actions: string[];
  roadmap_update?: string;
};

type EvolutionEvent = {
  ts: string;
  cycle: number;
  status: string;
  reason?: string;
  score?: number;
  tool?: string;
  changed_count?: number;
};

type EventSummary = {
  totalCycles: number;
  successfulPromotions: number;
  failedCycles: number;
  successRate: number;
  consecutiveFailures: number;
  commonFailureModes: Record<string, number>;
  lastSuccessfulTool?: string;
  avgScore: number;
};

export class DaoPlanner {
  root: string;
  agentsPath: string;
  roadmapPath: string;
  logsDir: string;
  stateDir: string;
  logger = setupLogger("dao.planner");

  constructor(root: string) {
    this.root = root;
    this.agentsPath = path.join(root, "AGENTS.md");
    this.roadmapPath = path.join(root, "ROADMAP.md");
    this.logsDir = path.join(root, "logs");
    this.stateDir = path.join(root, "state");
  }

  async plan(
    tool: { name: string; run_cmd: string },
    onLog?: (msg: string) => void
  ): Promise<PlanResult | null> {
    const log = (msg: string) => onLog ? onLog(msg) : console.log(msg);

    this.logger.info({ tool: tool.name }, "开始生成进化规划");

    const agents = await this._safeRead(this.agentsPath);
    const roadmap = await this._safeRead(this.roadmapPath);
    const recentEvents = await this._getRecentEvents(15);
    const eventSummary = this._summarizeEvents(recentEvents);

    this.logger.info({
      total_cycles: eventSummary.totalCycles,
      success_rate: eventSummary.successRate,
      consecutive_failures: eventSummary.consecutiveFailures
    }, "执行记录分析完成");

    const failureModesStr = Object.entries(eventSummary.commonFailureModes)
      .sort((a, b) => b[1] - a[1])
      .map(([mode, count]) => `   - ${mode}: ${count} 次`)
      .join("\n") || "   无显著失败模式";

    const prompt = `
你是本项目的"大脑" (Planner Agent)。你的任务是分析当前进化状态，并规划接下来的具体目标。

### 1. 宪法 (AGENTS.md)
${agents}

### 2. 当前路线图 (ROADMAP.md)
${roadmap}

### 3. 执行记录统计 (Event Summary)
- 总周期数：${eventSummary.totalCycles}
- 成功晋升：${eventSummary.successfulPromotions}
- 失败周期：${eventSummary.failedCycles}
- 成功率：${(eventSummary.successRate * 100).toFixed(1)}%
- 连续失败：${eventSummary.consecutiveFailures}
- 平均得分：${eventSummary.avgScore.toFixed(2)}
- 最后成功工具：${eventSummary.lastSuccessfulTool || "无"}

### 4. 失败模式分析 (Failure Mode Analysis)
${failureModesStr}

### 5. 最近执行记录 (Recent Events, 最近 15 条)
${recentEvents.map(e => `   [Cycle ${e.cycle}] ${e.status}: ${e.reason || "ok"} (tool=${e.tool || "n/a"}, score=${e.score?.toFixed(2) || "n/a"})`).join("\n")}

### 你的任务：
1. **反思**：
   - 为什么之前的尝试成功或失败了？
   - 是否存在重复的失败模式？
   - 当前工具链是否适合目标任务？

2. **规划**：
   - 基于路线图和反思，确定下一轮进化的"具体目标" (next_objective)
   - 推荐"优先动作" (next_actions)，考虑之前的失败原因
   - 如果连续失败 >= 3 次，建议切换策略或降低目标复杂度

3. **更新路线图**：如果需要，建议对 ROADMAP.md 的修改。

### 输出格式：
必须返回合法的 JSON 对象，包含以下字段：
- thought: 你的深度思考过程（包括对失败模式的分析）。
- next_objective: 下一轮的具体目标（字符串）。
- next_actions: 优先级排序的动作列表（字符串数组）。
- roadmap_update: (可选) 对 ROADMAP.md 的最新观察或待办建议。

**注意：请直接输出 JSON，不要包含额外的 Markdown 代码块语法，除非工具要求。**
`;

    const tmpPromptFile = path.join(this.stateDir, "last_planner_prompt.txt");
    await fs.writeFile(tmpPromptFile, prompt, "utf-8");

    // 调用工具进行推断 (Inquiry Call)
    let cmd = tool.run_cmd;
    
    const replacements: Record<string, string> = {
      prompt_file: JSON.stringify(tmpPromptFile).slice(1, -1)
    };
    for (const [k, v] of Object.entries(replacements)) cmd = cmd.split(`{${k}}`).join(v);

    log(chalk.blueBright(`[Planner] 执行规划命令: ${cmd}`));
    const cp = spawnSync("sh", ["-c", cmd], { cwd: this.root, encoding: "utf-8" });
    
    const output = cp.stdout || "";
    const stderr = cp.stderr || "";

    if (cp.status !== 0) {
      log(chalk.red(`[Planner] 规划工具进程报错 (退出码: ${cp.status})`));
      if (stderr) log(chalk.red(`[Planner] STDERR: ${stderr.trim()}`));
      // Don't return null yet, try to see if it output valid JSON before crashing
    }

    if (!output.trim()) {
      log(chalk.red("[Planner] 规划工具未返回任何标准输出"));
      return null;
    }

    try {
      // 提取 JSON (Handle stream-json where multiple objects might exist)
      const lines = output.split("\n").filter((line: string) => line.trim().startsWith("{"));
      
      for (const line of lines.reverse()) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "assistant" && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === "text" && block.text) {
                const jsonMatch = block.text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const res = JSON.parse(jsonMatch[0]) as PlanResult;
                  if (res.next_objective) return res;
                }
              }
            }
          }
          if (obj.next_objective && obj.next_actions) return obj as PlanResult;
        } catch { continue; }
      }

      // Fallback: full text search
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const res = JSON.parse(jsonMatch[0]) as PlanResult;
        if (res.next_objective) return res;
      }
      
      log(chalk.yellow("[Planner] 无法从结构化输出中解析 JSON，尝试展示原始响应以供调试..."));
      log(chalk.white(`--- 工具输出开始 ---\n${output.slice(0, 2000)}\n--- 工具输出结束 ---`));
    } catch (e) {
      log(chalk.red(`[Planner] 解析异常: ${e instanceof Error ? e.message : String(e)}`));
    }
    return null;
  }

  private async _safeRead(p: string): Promise<string> {
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      return "";
    }
  }

  private async _getRecentEvents(n: number): Promise<EvolutionEvent[]> {
    const p = path.join(this.logsDir, "evolution_events.jsonl");
    try {
      const data = await fs.readFile(p, "utf-8");
      const lines = data.split("\n").filter(Boolean);
      const events: EvolutionEvent[] = lines.slice(-n).map((line: string) => JSON.parse(line));
      return events;
    } catch {
      return [];
    }
  }

  private _summarizeEvents(events: EvolutionEvent[]): EventSummary {
    const total = events.length;
    if (total === 0) {
      return {
        totalCycles: 0,
        successfulPromotions: 0,
        failedCycles: 0,
        successRate: 0,
        consecutiveFailures: 0,
        commonFailureModes: {},
        avgScore: 0
      };
    }

    const successfulPromotions = events.filter(e => e.status === "PROMOTED").length;
    const failedCycles = events.filter(e => e.status === "FAIL").length;
    const successRate = successfulPromotions / total;

    // 计算连续失败次数
    let consecutiveFailures = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].status === "FAIL") {
        consecutiveFailures++;
      } else {
        break;
      }
    }

    // 分析失败模式
    const failureModes: Record<string, number> = {};
    for (const e of events) {
      if (e.status === "FAIL" && e.reason) {
        const mode = this._classifyFailureMode(e.reason);
        failureModes[mode] = (failureModes[mode] || 0) + 1;
      }
    }

    // 找到最后成功的工具
    const lastSuccessfulEvent = events.slice().reverse().find(e => e.status === "PROMOTED");
    const lastSuccessfulTool = lastSuccessfulEvent?.tool;

    // 计算平均得分
    const scores = events.filter(e => e.score !== undefined).map(e => e.score!);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    return {
      totalCycles: total,
      successfulPromotions,
      failedCycles,
      successRate,
      consecutiveFailures,
      commonFailureModes: failureModes,
      lastSuccessfulTool,
      avgScore
    };
  }

  private _classifyFailureMode(reason: string): string {
    const lower = reason.toLowerCase();
    if (lower.includes("timeout") || lower.includes("无响应")) return "timeout";
    if (lower.includes("无代码改动") || lower.includes("no changes")) return "no_changes";
    if (lower.includes("校验") || lower.includes("validation") || lower.includes("build")) return "validation_failed";
    if (lower.includes("护栏") || lower.includes("guard") || lower.includes("protected")) return "guard_blocked";
    if (lower.includes("git") || lower.includes("merge") || lower.includes("branch")) return "git_error";
    if (lower.includes("工具") || lower.includes("tool") || lower.includes("exit")) return "tool_error";
    return "unknown";
  }

  private async _updateRoadmap(newObservation: string): Promise<void> {
    let current = await this._safeRead(this.roadmapPath);
    if (!current) return;

    const now = new Date().toISOString().split("T")[0];
    const update = `\n- [ ] [Auto-Obs ${now}] ${newObservation}`;
    
    if (current.includes("## 1. 核心观察")) {
      current = current.replace("## 1. 核心观察", `## 1. 核心观察${update}`);
      await fs.writeFile(this.roadmapPath, current, "utf-8");
    }
  }
}

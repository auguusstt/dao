import path from "path";
import { promises as fs } from "fs";
import { spawn, spawnSync } from "child_process";
import os from "os";
import readline from "readline";
import chalk from "chalk";
import { readJson, writeJson, appendJsonl, nowIso, ensureDir } from "../common/fs.js";
import { setupLogger, logSummary } from "./logging_utils.js";

type ToolSpec = { name: string; check_cmd: string; run_cmd: string };

type EvolutionConfig = {
  objectives: string[];
  validate_commands: string[];
  protected_paths: string[];
  allowed_edit_roots: string[];
  toolchain: ToolSpec[];
  min_score_promote: number;
  inactivity_timeout_sec: number;
  total_timeout_sec: number;
};

class EvoTUI {
  private cycle: number = 0;
  private objective: string = "";
  private phase: string = "";
  private message: string = "";
  private logs: string[] = [];
  private readonly maxLogs = 10;
  private isTTY: boolean;

  constructor() {
    this.isTTY = process.stdout.isTTY;
  }

  updateStatus(cycle: number, objective: string, phase: string, message: string) {
    this.cycle = cycle;
    this.objective = objective;
    this.phase = phase;
    this.message = message;
    this.render();
  }

  addLog(text: string) {
    this.logs.push(text);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.render();
  }

  render() {
    if (!this.isTTY) {
      console.log(`[Cycle ${this.cycle}] [${this.phase}] ${this.message}`);
      return;
    }

    // Move cursor to top and clear screen below
    process.stdout.write("\x1b[H\x1b[J");

    console.log(chalk.cyan.bold("=== DAO Evolution Terminal ==="));
    console.log(`${chalk.yellow("Cycle:")} ${this.cycle}`);
    console.log(`${chalk.yellow("Objective:")} ${this.objective}`);
    console.log(`${chalk.yellow("Status:")} ${chalk.green(this.phase)} - ${this.message}`);
    console.log("");
    console.log(chalk.blue.bold("--- Progress Tree ---"));
    this.renderTree();
    console.log("");
    console.log(chalk.magenta.bold("--- Tool Output (Last 10 Lines) ---"));
    for (const log of this.logs) {
      process.stdout.write(chalk.gray(log.slice(0, process.stdout.columns - 5)) + "\n");
    }
  }

  private renderTree() {
    const phases = [
      "START", "ENSURE_HEAD", "CHECK_CLEAN", "CHECK_TOOLS", 
      "CREATE_WORKTREE", "RUN_TOOL", "VALIDATE", "COMMIT", "MERGE", "DONE"
    ];
    let foundCurrent = false;
    for (const p of phases) {
      if (p === this.phase) {
        console.log(`${chalk.green(" ●")} ${chalk.bold(p)} <-- Current`);
        foundCurrent = true;
      } else if (!foundCurrent) {
        console.log(`${chalk.green(" ✓")} ${chalk.gray(p)}`);
      } else {
        console.log(`${chalk.gray(" ○")} ${chalk.gray(p)}`);
      }
    }
  }
}

export class DaoEvolver {
  root: string;
  configDir: string;
  stateDir: string;
  logsDir: string;
  worktreesDir: string;
  agentsPath: string;
  config!: EvolutionConfig;
  globalObjective!: string;
  agentsExcerpt!: string;
  logger = setupLogger("dao.evolver");
  tui = new EvoTUI();

  constructor(root: string) {
    this.root = root;
    this.configDir = path.join(root, "config");
    this.stateDir = path.join(root, "state");
    this.logsDir = path.join(root, "logs");
    this.worktreesDir = path.join(root, ".worktrees");
    this.agentsPath = path.join(root, "AGENTS.md");
  }

  async _loadConfig(): Promise<EvolutionConfig> {
    const raw = await readJson<any>(path.join(this.configDir, "evolution.json"));
    return {
      objectives: raw.objectives,
      validate_commands: raw.validate_commands,
      protected_paths: raw.protected_paths,
      allowed_edit_roots: raw.allowed_edit_roots,
      toolchain: raw.toolchain,
      min_score_promote: Number(raw.min_score_promote),
      inactivity_timeout_sec: Number(raw.inactivity_timeout_sec ?? 30),
      total_timeout_sec: Number(raw.total_timeout_sec ?? 300)
    };
  }

  async bootstrap(): Promise<void> {
    await ensureDir(this.stateDir);
    await ensureDir(this.logsDir);
    await ensureDir(this.worktreesDir);
    this.config = await this._loadConfig();
    const [globalObjective, agentsExcerpt] = await this._loadAgentsContext();
    this.globalObjective = globalObjective;
    this.agentsExcerpt = agentsExcerpt;
    const runtimePath = path.join(this.stateDir, "evolution_runtime.json");
    try {
      await fs.access(runtimePath);
    } catch {
      const runtime = { cycle: 0, successful_promotions: 0, failed_cycles: 0, last_tool: "", history: [] as any[] };
      await writeJson(runtimePath, runtime);
    }
    await this._initPlanIfMissing();
  }

  async run(cycles: number, sleepSeconds: number): Promise<void> {
    await this.bootstrap();
    for (let i = 0; i < cycles; i++) {
      const cont = await this.runOnce();
      if (!cont) break;
      if (sleepSeconds > 0) await new Promise(r => setTimeout(r, sleepSeconds * 1000));
    }
  }

  async runOnce(): Promise<boolean> {
    const runtimePath = path.join(this.stateDir, "evolution_runtime.json");
    const runtime = await readJson<any>(runtimePath);
    runtime.cycle = Number(runtime.cycle) + 1;
    const cycle = Number(runtime.cycle);
    const cycleStarted = Date.now();
    const [objective, plan] = await this._nextObjective(runtime);

    const updateUI = (phase: string, msg: string) => {
      this.tui.updateStatus(cycle, objective, phase, msg);
    };

    updateUI("START", "开始新一轮进化");
    await this._setLiveStatus(cycle, "START", "开始新一轮进化");
    await this._trace(cycle, "START", "开始新一轮进化", {});

    updateUI("ENSURE_HEAD", "检查仓库 HEAD");
    const [headOk, headReason] = await this._ensureGitHead();
    if (!headOk) {
      runtime.failed_cycles += 1;
      this._record(runtime, cycle, "FAIL", headReason, 0.0, "");
      await writeJson(runtimePath, runtime);
      updateUI("FAIL", headReason);
      await this._trace(cycle, "FAIL", headReason, { step: "ENSURE_HEAD" });
      return false;
    }

    updateUI("CHECK_CLEAN", "检查主仓库是否干净");
    const [okClean, cleanReason] = await this._checkMainRepoClean();
    if (!okClean) {
      this._record(runtime, cycle, "SKIP", cleanReason, 0.0, "");
      await writeJson(runtimePath, runtime);
      updateUI("SKIP", cleanReason);
      await this._trace(cycle, "SKIP", cleanReason, { step: "CHECK_CLEAN" });
      return false;
    }

    updateUI("CHECK_TOOLS", "检测可用工具");
    const tools = await this._availableTools();
    if (tools.length === 0) {
      const reason = "未检测到可用工具，请配置 config/evolution.json 中的 toolchain";
      runtime.failed_cycles += 1;
      this._record(runtime, cycle, "FAIL", reason, 0.0, "");
      await writeJson(runtimePath, runtime);
      updateUI("FAIL", reason);
      await this._trace(cycle, "FAIL", reason, { step: "CHECK_TOOLS" });
      return false;
    }

    const tool = tools[(cycle - 1) % tools.length];
    const branch = `auto/evo-${new Date().toISOString().replace(/[:.]/g, "-")}-${cycle}`;
    const worktree = path.join(this.worktreesDir, branch.replace(/\//g, "-"));
    await this._trace(cycle, "PLAN", "已选择工具与目标", {
      tool: tool.name,
      objective,
      branch,
      active_objective: plan.active_objective,
      next_actions: plan.next_actions || []
    });

    updateUI("CREATE_WORKTREE", "创建隔离工作树");
    const created = await this._createWorktree(branch, worktree);
    if (!created) {
      runtime.failed_cycles += 1;
      this._record(runtime, cycle, "FAIL", "创建 worktree 失败", 0.0, tool.name);
      await writeJson(runtimePath, runtime);
      updateUI("FAIL", "创建 worktree 失败");
      await this._trace(cycle, "FAIL", "创建 worktree 失败", { tool: tool.name, branch });
      return false;
    }
    try {
      updateUI("RUN_TOOL", `调用工具: ${tool.name}`);
      const promptFile = await this._buildPromptFile(worktree, cycle, objective);
      const [toolOk, toolOut] = await this._runTool(cycle, tool, worktree, promptFile);
      await this._trace(cycle, "TOOL_RESULT", "工具调用结束", { tool: tool.name, tool_ok: toolOk, tool_output_preview: toolOut.slice(0, 120) });

      updateUI("VALIDATE", "执行验证与护栏检查");
      const changedFiles = await this._changedFiles(worktree);
      const [guardOk, guardReason] = this._guardChanges(changedFiles);
      const [validateOk, validateDetail] = await this._validate(worktree);
      const score = this._score(toolOk, changedFiles, guardOk, validateOk);
      await this._trace(cycle, "EVAL", "完成评分", { score, changed: changedFiles.length, guard_ok: guardOk, validate_ok: validateOk });

      if (toolOk && changedFiles.length && guardOk && validateOk && score >= this.config.min_score_promote) {
        updateUI("COMMIT", "候选提交");
        const [commitOk, commitMsg] = await this._commitCandidate(worktree, cycle, objective, tool.name, score);
        let mergeOk = false;
        let mergeMsg = "未执行 merge";
        if (commitOk) {
          updateUI("MERGE", "尝试快进合并到 main");
          const r = await this._mergeBranch(branch);
          mergeOk = r[0];
          mergeMsg = r[1];
        }
        if (commitOk && mergeOk) {
          runtime.successful_promotions += 1;
          runtime.last_tool = tool.name;
          const reason = `晋升成功: ${mergeMsg}`;
          this._record(runtime, cycle, "PROMOTED", reason, score, tool.name, changedFiles.length);
          updateUI("DONE", reason);
          await this._trace(cycle, "PROMOTED", reason, { tool: tool.name, score });
        } else {
          runtime.failed_cycles += 1;
          const reason = `提交或合并失败: commit=${commitMsg}; merge=${mergeMsg}`;
          this._record(runtime, cycle, "FAIL", reason, score, tool.name, changedFiles.length);
          updateUI("FAIL", reason);
          await this._trace(cycle, "FAIL", reason, { tool: tool.name, score });
        }
      } else {
        runtime.failed_cycles += 1;
        const reason = `未达晋升条件; tool_ok=${toolOk}; changed=${changedFiles.length}; guard_ok=${guardOk}; validate_ok=${validateOk}; guard_reason=${guardReason}`;
        this._record(runtime, cycle, "FAIL", reason, score, tool.name, changedFiles.length);
        updateUI("FAIL", reason);
        await this._trace(cycle, "FAIL", reason, { tool: tool.name, score, changed: changedFiles.length });
      }
    } finally {
      await this._cleanupWorktree(worktree, branch);
      const elapsed = Math.round((Date.now() - cycleStarted) / 1000);
      await this._trace(cycle, "END", "本轮结束", { elapsed_sec: elapsed });
      await writeJson(runtimePath, runtime);
    }
    return true;
  }

  async _checkMainRepoClean(): Promise<[boolean, string]> {
    const cp = spawnSync("git", ["status", "--porcelain"], { cwd: this.root, encoding: "utf-8" });
    if (cp.status !== 0) return [false, cp.stderr?.trim() || "git status 失败"];
    if (cp.stdout.trim()) return [false, "主仓库存在未提交改动，暂停自动进化"];
    return [true, "ok"];
  }

  async _availableTools(): Promise<ToolSpec[]> {
    const out: ToolSpec[] = [];
    for (const t of this.config.toolchain) {
      const cp = spawnSync("bash", ["-lc", t.check_cmd], { cwd: this.root, encoding: "utf-8" });
      if ((cp.status ?? 1) === 0) out.push(t);
    }
    return out;
  }

  async _ensureGitHead(): Promise<[boolean, string]> {
    const cp = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: this.root, encoding: "utf-8" });
    if ((cp.status ?? 1) === 0) return [true, "ok"];
    const addTargets = ["README.md", "config", "src", "pyproject.toml", "uv.lock"];
    const existing = addTargets.filter(p => fs.access(path.join(this.root, p)).then(() => true).catch(() => false));
    const resolved = await Promise.all(existing);
    const present = addTargets.filter((_, i) => resolved[i]);
    const add = spawnSync("git", ["add", ...present], { cwd: this.root, encoding: "utf-8" });
    if ((add.status ?? 1) !== 0) return [false, add.stderr?.trim() || "初始化 add 失败"];
    const commit = spawnSync("git", ["commit", "-m", "chore: bootstrap autonomous evolution core"], { cwd: this.root, encoding: "utf-8" });
    if ((commit.status ?? 1) !== 0) {
      const detail = `${commit.stdout}\n${commit.stderr}`.trim();
      return [false, `初始化提交失败: ${detail.slice(0, 260)}`];
    }
    return [true, "bootstrap commit created"];
  }

  async _createWorktree(branch: string, p: string): Promise<boolean> {
    const cp = spawnSync("git", ["worktree", "add", "-b", branch, p, "HEAD"], { cwd: this.root, encoding: "utf-8" });
    return (cp.status ?? 1) === 0;
  }

  async _buildPromptFile(worktree: string, cycle: number, objective: string): Promise<string> {
    const runtime = await readJson<any>(path.join(this.stateDir, "evolution_runtime.json"));
    const summary = {
      cycle,
      global_objective: this.globalObjective,
      objective,
      history_tail: (runtime.history || []).slice(-5),
      constraints: {
        allowed_edit_roots: this.config.allowed_edit_roots,
        protected_paths: this.config.protected_paths,
        must_pass: this.config.validate_commands
      }
    };
    const prompt =
      "你是项目内的自主编码 agent。请在当前工作树做一次最小可验证改进。\n" +
      "要求：\n" +
      "1) 仅修改允许目录。\n" +
      "2) 不可修改受保护路径。\n" +
      "3) 改动后必须能通过验证命令。\n" +
      "4) 优先提升稳定性、可观测性、可恢复性。\n\n" +
      "全局进化章程（来自 AGENTS.md，必须遵守）：\n" +
      `${this.agentsExcerpt}\n\n` +
      `上下文：\n${JSON.stringify(summary, null, 2)}\n`;
    const tmpDir = path.join(os.tmpdir(), "dao_evo_prompts");
    await ensureDir(tmpDir);
    const file = path.join(tmpDir, `evo_prompt_cycle_${cycle}.txt`);
    await fs.writeFile(file, prompt, "utf-8");
    return file;
  }

  async _runTool(cycle: number, tool: ToolSpec, worktree: string, promptFile: string): Promise<[boolean, string]> {
    let cmd = tool.run_cmd;
    const replacements: Record<string, string> = {
      worktree: JSON.stringify(worktree).slice(1, -1),
      prompt_file: JSON.stringify(promptFile).slice(1, -1)
    };
    for (const [k, v] of Object.entries(replacements)) cmd = cmd.split(`{${k}}`).join(v);
    let promptText = "";
    try {
      promptText = await fs.readFile(promptFile, "utf-8");
    } catch {
      promptText = "";
    }
    const env = { ...(process as any).env, LC_ALL: "C", LANG: "C" };
    const proc = spawn("bash", ["-lc", cmd], { cwd: worktree, env });
    const lines: string[] = [];
    let timedOut = false;
    const started = Date.now();
    const inactivityTimeoutMs = this.config.inactivity_timeout_sec * 1000;
    const totalTimeoutMs = this.config.total_timeout_sec * 1000;
    let lastOutputTime = Date.now();
    const startTime = Date.now();

    const timer = setInterval(() => {
      const now = Date.now();
      const inactiveElapsed = now - lastOutputTime;
      const totalElapsed = now - startTime;

      if (inactiveElapsed > inactivityTimeoutMs) {
        timedOut = true;
        this.tui.addLog(chalk.red(`[Timeout] Inactivity for ${this.config.inactivity_timeout_sec}s`));
        try { proc.kill(); } catch {}
        clearInterval(timer);
      } else if (totalElapsed > totalTimeoutMs) {
        timedOut = true;
        this.tui.addLog(chalk.red(`[Timeout] Total execution time exceeded ${this.config.total_timeout_sec}s`));
        try { proc.kill(); } catch {}
        clearInterval(timer);
      }
    }, 500);

    proc.stdout.on("data", (d: any) => {
      lastOutputTime = Date.now();
      const line = String(d).trim();
      if (line) {
        lines.push(`[stdout] ${line}`);
        this.tui.addLog(`[stdout] ${line}`);
      }
      this._toolStream(cycle, tool.name, "stdout", line);
    });
    proc.stderr.on("data", (d: any) => {
      lastOutputTime = Date.now();
      const line = String(d).trim();
      if (line) {
        lines.push(`[stderr] ${line}`);
        this.tui.addLog(`[stderr] ${line}`);
      }
      this._toolStream(cycle, tool.name, "stderr", line);
    });
    this._toolStream(cycle, tool.name, "cmd", `bash -lc ${cmd}`);
    if (promptText) this._toolStream(cycle, tool.name, "prompt", promptText.split(/\s+/).join(" ").slice(0, 220));
    const rc: number = await new Promise(resolve => proc.on("close", (code: any) => resolve(Number(code ?? 1))));
    clearInterval(timer);
    // If we have changes, we might consider it OK even if exit code is non-zero (common with some LLM CLIs)
    const ok = (rc === 0 || lines.length > 10) && !timedOut;
    return [ok, lines.join("\n")];
  }

  async _changedFiles(worktree: string): Promise<string[]> {
    const cp = spawnSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf-8" });
    if ((cp.status ?? 1) !== 0) return [];
    const files: string[] = [];
    for (const line of cp.stdout.split("\n")) {
      if (!line.trim()) continue;
      files.push(line.slice(3).trim());
    }
    return files;
  }

  _guardChanges(files: string[]): [boolean, string] {
    if (!files.length) return [false, "无代码改动"];
    for (const f of files) {
      const p = f.replace(/\\/g, "/");
      if (this.config.protected_paths.some(prot => p === prot || p.startsWith(prot.replace(/\/$/, "") + "/"))) {
        return [false, `触碰受保护路径: ${p}`];
      }
      if (!this.config.allowed_edit_roots.some(root => p === root || p.startsWith(root.replace(/\/$/, "") + "/"))) {
        return [false, `改动不在允许目录: ${p}`];
      }
    }
    return [true, "ok"];
  }

  async _validate(worktree: string): Promise<[boolean, string]> {
    if (!this.config.validate_commands || this.config.validate_commands.length === 0) return [true, "未配置验证命令"];
    for (const cmd of this.config.validate_commands) {
      const cp = spawnSync("bash", ["-lc", cmd], { cwd: worktree, encoding: "utf-8" });
      if ((cp.status ?? 1) !== 0) {
        const err = `${cp.stdout}\n${cp.stderr}`.trim();
        return [false, `验证失败: ${cmd}; ${err.slice(0, 300)}`];
      }
    }
    return [true, "ok"];
  }

  _score(toolOk: boolean, changedFiles: string[], guardOk: boolean, validateOk: boolean): number {
    let s = 0;
    if (toolOk) s += 0.25;
    if (changedFiles.length) s += 0.25;
    if (guardOk) s += 0.25;
    if (validateOk) s += 0.25;
    return Number(s.toFixed(6));
  }

  async _commitCandidate(worktree: string, cycle: number, objective: string, toolName: string, score: number): Promise<[boolean, string]> {
    const add = spawnSync("git", ["add", "-A"], { cwd: worktree, encoding: "utf-8" });
    if ((add.status ?? 1) !== 0) return [false, add.stderr?.trim() || "git add 失败"];
    const msg = `auto(evo): cycle=${cycle} tool=${toolName} score=${score.toFixed(3)} obj=${objective.slice(0, 40)}`;
    const commit = spawnSync("git", ["commit", "-m", msg], { cwd: worktree, encoding: "utf-8" });
    if ((commit.status ?? 1) !== 0) {
      const output = `${commit.stdout}\n${commit.stderr}`.trim().slice(0, 300);
      return [false, output];
    }
    return [true, msg];
  }

  async _mergeBranch(branch: string): Promise<[boolean, string]> {
    const cp = spawnSync("git", ["merge", "--ff-only", branch], { cwd: this.root, encoding: "utf-8" });
    const out = `${cp.stdout}\n${cp.stderr}`.trim();
    return [(cp.status ?? 1) === 0, out.slice(0, 300)];
  }

  async _cleanupWorktree(worktree: string, branch: string): Promise<void> {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: this.root, encoding: "utf-8" });
    spawnSync("git", ["branch", "-D", branch], { cwd: this.root, encoding: "utf-8" });
  }

  _record(runtime: any, cycle: number, status: string, reason: string, score: number, toolName: string, changedCount: number = 0): void {
    const event = { ts: nowIso(), cycle, status, reason, score, tool: toolName, changed_count: changedCount };
    runtime.history.push(event);
    this._retrospectAndUpdatePlan(event);
    appendJsonl(path.join(this.logsDir, "evolution_events.jsonl"), event);
    this._emitConsoleLog("events", event);
    
    logSummary(this.logger, { 
      cycle, 
      status, 
      score, 
      tool: toolName, 
      reason, 
      changed_count: changedCount 
    });
  }

  _planPath(): string {
    return path.join(this.stateDir, "evolution_plan.json");
  }

  _defaultPlan(): any {
    const objectives = this.config.objectives?.length ? [...this.config.objectives] : ["提升稳定性与可恢复性"];
    return {
      updated_at: nowIso(),
      active_objective: objectives[0],
      objective_index: 0,
      objectives,
      next_actions: ["先产出一个最小可验证改动，并确保通过 validate_commands"],
      last_retrospective: {}
    };
  }

  async _initPlanIfMissing(): Promise<void> {
    const p = this._planPath();
    try {
      await fs.access(p);
    } catch {
      await writeJson(p, this._defaultPlan());
    }
  }

  async _readPlan(): Promise<any> {
    const p = this._planPath();
    try {
      await fs.access(p);
      return await readJson<any>(p);
    } catch {
      const plan = this._defaultPlan();
      await writeJson(p, plan);
      return plan;
    }
  }

  async _writePlan(plan: any): Promise<void> {
    plan.updated_at = nowIso();
    await writeJson(this._planPath(), plan);
  }

  async _nextObjective(runtime: any): Promise<[string, any]> {
    const plan = await this._readPlan();
    let base = String(plan.active_objective || "").trim();
    if (!base) {
      const objectives = plan.objectives || this.config.objectives;
      const idx = Number(plan.objective_index || 0) % Math.max(1, objectives.length);
      base = objectives[idx];
      plan.active_objective = base;
      await this._writePlan(plan);
    }
    const tail = (runtime.history || []).slice(-3);
    if (tail.length && tail.every((i: any) => i.status === "FAIL")) {
      const reasons = tail.map((i: any) => String(i.reason || "").slice(0, 80)).join(" | ");
      plan.next_actions = ["先消除最近连续失败的主因，再扩展目标", `最近失败摘要: ${reasons}`];
      await this._writePlan(plan);
    }
    const nextActions = (plan.next_actions || []).map((i: any) => String(i).trim()).filter(Boolean);
    const objective = nextActions.length ? `${base}；本轮优先动作：${nextActions[0]}` : base;
    return [objective, plan];
  }

  async _retrospectAndUpdatePlan(event: any): Promise<void> {
    const plan = await this._readPlan();
    const objectives = plan.objectives || this.config.objectives;
    let idx = Number(plan.objective_index || 0) % Math.max(1, objectives.length);
    const reason = String(event.reason || "");
    const status = String(event.status || "");
    if (status === "PROMOTED") {
      idx = (idx + 1) % Math.max(1, objectives.length);
      plan.objective_index = idx;
      plan.active_objective = objectives[idx];
      plan.next_actions = ["基于当前目标做下一步最小可验证改进"];
    } else {
      if (reason.includes("无代码改动")) {
        plan.next_actions = ["必须至少修改 1 个允许目录内文件", "改动优先落在日志/可观测性并保持最小范围"];
      } else if (reason.includes("验证失败")) {
        plan.next_actions = ["先本地执行并修复 validate_commands，再提交改动", "优先修复语法/依赖问题，避免扩展需求"];
      } else if (reason.includes("触碰受保护路径") || reason.includes("改动不在允许目录")) {
        plan.next_actions = ["严格限定改动到 allowed_edit_roots", "不要触碰 protected_paths"];
      } else if (reason.includes("timeout")) {
        plan.next_actions = ["缩小本轮范围，只做单点最小改动", "先输出可执行计划再改代码，降低超时概率"];
      } else {
        plan.next_actions = ["对齐最近失败原因，先做可通过验证的最小一步"];
      }
    }
    plan.last_retrospective = { cycle: event.cycle, status, score: event.score, reason: reason.slice(0, 300) };
    await this._writePlan(plan);
  }

  async _loadAgentsContext(): Promise<[string, string]> {
    try {
      const text = await fs.readFile(this.agentsPath, "utf-8");
      const m = text.match(/^总目标[：:]\s*(.+)$/m);
      const globalObjective = m ? m[1].trim() : "按 AGENTS.md 约束推进长期自主进化目标";
      let excerpt = text.slice(0, 1600).trim();
      if (text.length > 1600) excerpt += "\n...(truncated)";
      return [globalObjective, excerpt];
    } catch {
      const fallback = "持续提升系统稳定性、可观测性、可恢复性，并通过最小可验证改动推进。";
      return [fallback, `(AGENTS.md 缺失，使用默认章程) ${fallback}`];
    }
  }

  async _setLiveStatus(cycle: number, phase: string, message: string): Promise<void> {
    const payload = { ts: nowIso(), cycle, phase, message };
    await writeJson(path.join(this.stateDir, "evolution_live.json"), payload);
  }

  async _trace(cycle: number, phase: string, message: string, detail: Record<string, any>): Promise<void> {
    const payload = { ts: nowIso(), cycle, phase, message, detail };
    await appendJsonl(path.join(this.logsDir, "evolution_trace.jsonl"), payload);
    this._emitConsoleLog("trace", payload);
  }

  _toolStream(cycle: number, tool: string, stream: string, text: string): void {
    const payload = { ts: nowIso(), cycle, tool, stream, text };
    appendJsonl(path.join(this.logsDir, "evolution_tool_stream.jsonl"), payload);
    this._emitConsoleLog("tool_stream", payload);
  }

  _emitConsoleLog(channel: string, payload: Record<string, any>): void {
    const text = JSON.stringify(payload);
    console.log(`[evo-log:${channel}] ${text}`);
  }
}

export async function printStatus(root: string, tail: number = 8): Promise<void> {
  const r = path.resolve(root);
  const runtimeP = path.join(r, "state", "evolution_runtime.json");
  const liveP = path.join(r, "state", "evolution_live.json");
  const eventsP = path.join(r, "logs", "evolution_events.jsonl");
  const traceP = path.join(r, "logs", "evolution_trace.jsonl");
  const streamP = path.join(r, "logs", "evolution_tool_stream.jsonl");
  const planP = path.join(r, "state", "evolution_plan.json");
  console.log("=== DAO Evolution Status ===");
  try {
    const live = await readJson<any>(liveP);
    console.log(`live: cycle=${live.cycle} phase=${live.phase} ts=${live.ts}`);
    console.log(`live message: ${live.message}`);
  } catch {
    console.log("live: (no live status yet)");
  }
  try {
    const rt = await readJson<any>(runtimeP);
    console.log(`runtime: cycle=${rt.cycle} promoted=${rt.successful_promotions} failed=${rt.failed_cycles} last_tool=${rt.last_tool}`);
    const hist = rt.history || [];
    if (hist.length) {
      const last = hist[hist.length - 1];
      console.log(`last result: ${last.status} score=${last.score} tool=${last.tool} ts=${last.ts}`);
      console.log(`last reason: ${last.reason}`);
    }
  } catch {
    console.log("runtime: (not initialized)");
  }
  try {
    const plan = await readJson<any>(planP);
    console.log(`plan: index=${plan.objective_index} active=${plan.active_objective}`);
    const nextActions = plan.next_actions || [];
    if (nextActions.length) console.log(`plan next: ${nextActions[0]}`);
  } catch {
    console.log("plan: (not initialized)");
  }
  for (const p of [eventsP, traceP, streamP]) {
    try {
      const text = await fs.readFile(p, "utf-8");
      const lines = text.split("\n").filter(Boolean);
      const tailLines = lines.slice(-tail);
      console.log(`--- tail ${path.basename(p)} (${tailLines.length} lines) ---`);
      for (const line of tailLines) console.log(line);
    } catch {
      console.log(`${path.basename(p)}: (missing)`);
    }
  }
}

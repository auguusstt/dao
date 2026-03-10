import path from "path";
import { promises as fs } from "fs";
import { spawn, spawnSync } from "child_process";
import os from "os";
import chalk from "chalk";
import { TUI, Text, ProcessTerminal, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readJson, writeJson, appendJsonl, nowIso, ensureDir, backupFile } from "../common/fs.js";
import { setupLogger, logSummary, logException, checkEvolutionHealth, logHealthCheck, logToolFailure } from "./logging_utils.js";

type ToolSpec = { name: string; check_cmd: string; run_cmd: string; parser?: string };

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

type SubTask = { name: string; phase: string; status: "pending" | "running" | "success" | "fail"; reason?: string; startTime?: number };

class EvoTUI {
  private cycle: number = 0;
  private objective: string = "";
  private phase: string = "";
  private message: string = "";
  private subTasks: SubTask[] = [];
  private logs: string[] = [];
  private isTTY: boolean;
  private heartbeatTimer: NodeJS.Timeout;
  private terminal?: ProcessTerminal;
  private tui?: TUI;
  private logsText?: Text;
  private footerText?: Text;

  constructor() {
    this.isTTY = process.stdout.isTTY;
    if (this.isTTY) {
      this.terminal = new ProcessTerminal();
      this.tui = new TUI(this.terminal);
      
      // Layout: Logs (top, scrollable) → Footer (bottom, fixed)
      this.logsText = new Text("");
      this.footerText = new Text("");
      
      // Add in display order
      this.tui.addChild(this.logsText);
      this.tui.addChild(this.footerText);
      
      this.tui.start();
      this.refreshComponents();
      
      this.tui.addInputListener((data: string) => {
        if (matchesKey(data, Key.ctrl("c"))) {
          try { this.tui?.stop(); } catch {}
          try { clearInterval(this.heartbeatTimer); } catch {}
          process.exit(0);
        }
        return undefined;
      });
    }
    this.heartbeatTimer = setInterval(() => this.refreshComponents(), 1000);
  }

  updateStatus(cycle: number, objective: string, phase: string, message: string) {
    this.cycle = cycle;
    this.objective = objective;
    this.phase = phase;
    this.message = message;
    if (phase === "START") {
      this.subTasks = [];
    }
    this.refreshComponents();
  }

  setSubTask(name: string, status: SubTask["status"], reason?: string) {
    const existing = this.subTasks.find(t => t.name === name && t.phase === this.phase);
    if (existing) {
      existing.status = status;
      existing.reason = reason;
      if (status !== "running") delete existing.startTime;
    } else {
      this.subTasks.push({
        name,
        phase: this.phase,
        status,
        reason,
        startTime: status === "running" ? Date.now() : undefined
      });
    }
    this.refreshComponents();
  }

  addLog(text: string) {
    // Handle multi-line logs and clean them
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      this.logs.push(line);
    }
    this.refreshComponents();
  }

  appendLog(text: string) {
    if (this.logs.length === 0) {
      this.logs.push(text.trim());
    } else {
      // Append to the last line directly
      this.logs[this.logs.length - 1] += text;
    }
    this.refreshComponents();
  }

  private refreshComponents() {
    if (!this.isTTY) return;
    const width = this.terminal?.columns || process.stdout.columns || 80;
    const height = this.terminal?.rows || process.stdout.rows || 24;
    
    // Calculate footer height (reserved space at bottom)
    const footerReserved = 12; // Reserve ~12 lines for footer
    const maxLogLines = Math.max(1, height - footerReserved - 2);
    
    // Logs (top, scrollable - show latest lines that fit)
    const logLines: string[] = [];
    logLines.push(chalk.magenta.bold("━━━ 实时输出 Live Tool Output ━━━"));
    
    // Show only the lines that fit in the available space
    const displayLogs = this.logs.slice(-maxLogLines);
    for (const log of displayLogs) {
      logLines.push(chalk.gray("  " + log));
    }
    
    // Pad with empty lines to fill space (optional, for visual consistency)
    while (logLines.length < maxLogLines + 1) {
      logLines.push("");
    }
    
    this.logsText?.setText(logLines.join("\n"));
    
    // Footer (bottom, fixed) - contains Header + Status + Progress
    const footerLines: string[] = [];
    footerLines.push(chalk.cyan.bold("═══ DAO Evolution Terminal ═══"));
    footerLines.push(chalk.gray("─".repeat(Math.min(50, width))));
    
    // Status bar (compact single line)
    const statusLine = `${chalk.yellow("Cycle:")} ${chalk.white(this.cycle)}  ${chalk.gray("│")}  ${chalk.yellow("Phase:")} ${chalk.bold.green(this.phase)}  ${chalk.gray("│")}  ${chalk.cyan(this.message)}`;
    footerLines.push(truncateToWidth(statusLine, width));
    footerLines.push(chalk.gray("─".repeat(Math.min(50, width))));
    
    // Progress tree
    footerLines.push(chalk.blue.bold("进度树 Progress Tree:"));
    const phases = [
      "START", "ENSURE_HEAD", "CHECK_CLEAN", "CHECK_TOOLS",
      "CREATE_WORKTREE", "RUN_TOOL", "VALIDATE", "COMMIT", "MERGE", "DONE"
    ];
    let foundCurrent = false;
    for (const p of phases) {
      const isCurrent = p === this.phase;
      if (isCurrent) {
        footerLines.push(`${chalk.green(" ●")} ${chalk.bold.white(p)}`);
        foundCurrent = true;
      } else if (!foundCurrent) {
        footerLines.push(`${chalk.green(" ✓")} ${chalk.gray(p)}`);
      } else {
        footerLines.push(`${chalk.gray(" ○")} ${chalk.gray(p)}`);
      }
      const tasksInPhase = this.subTasks.filter(st => st.phase === p);
      for (const st of tasksInPhase) {
        const icon = st.status === "success" ? chalk.green("✓") :
                     st.status === "fail" ? chalk.red("✗") :
                     st.status === "running" ? chalk.yellow("⟳") : chalk.gray("○");
        let meta = "";
        if (st.status === "running" && st.startTime) {
          const elapsed = Math.floor((Date.now() - st.startTime) / 1000);
          meta = chalk.yellow(` (${elapsed}s)`);
        } else if (st.reason) {
          meta = chalk.red(` (${st.reason})`);
        }
        footerLines.push(`   ${icon} ${chalk.gray(st.name)}${meta}`);
      }
    }
    
    this.footerText?.setText(footerLines.join("\n"));
    
    this.tui?.requestRender(true);
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

  _logIO(msg: string, detail: Record<string, any> = {}): void {
    const text = `[IO] ${msg}`;
    this.tui.addLog(chalk.gray(text));
    this._trace(0, "IO", msg, detail);
  }

  _extractStreamText(obj: any): string | null {
    if (!obj) return null;
    if (typeof obj === "string") return obj;
    const pick = (v: any) => typeof v === "string" ? v : null;
    return pick(obj.content) ??
           pick(obj.delta) ??
           pick(obj.text) ??
           pick(obj?.delta?.content) ??
           pick(obj?.message?.content) ??
           pick(obj?.choices?.[0]?.delta?.content) ??
           pick(obj?.choices?.[0]?.message?.content) ??
           pick(obj?.data?.content) ??
           null;
  }

  _getParser(tool: ToolSpec): (line: string) => string | null {
    const name = (tool.parser || "").toLowerCase();
    const tryJson = (line: string) => {
      try {
        const obj = JSON.parse(line);
        const t = this._extractStreamText(obj);
        return (t && t.trim()) || null;
      } catch {
        return null;
      }
    };
    if (name === "qwen" || name === "codebuddy" || name === "gemini") {
      return tryJson;
    }
    if (tool.run_cmd.includes("stream-json")) {
      return tryJson;
    }
    return (_line: string) => null;
  }

  async _loadConfig(): Promise<EvolutionConfig> {
    const p = path.join(this.configDir, "evolution.json");
    try {
      this._logIO("读取配置", { path: p });
      const raw = await readJson<any>(p);
      return {
        objectives: raw.objectives || [],
        validate_commands: raw.validate_commands || [],
        protected_paths: raw.protected_paths || [],
        allowed_edit_roots: raw.allowed_edit_roots || [],
        toolchain: raw.toolchain || [],
        min_score_promote: Number(raw.min_score_promote ?? 0.8),
        inactivity_timeout_sec: Number(raw.inactivity_timeout_sec ?? 30),
        total_timeout_sec: Number(raw.total_timeout_sec ?? 300)
      };
    } catch (err) {
      logException(this.logger, err, `Failed to load config from ${p}`);
      throw err;
    }
  }

  async bootstrap(): Promise<void> {
    this._logIO("创建/检查状态目录", { path: this.stateDir });
    await ensureDir(this.stateDir);
    this._logIO("创建/检查日志目录", { path: this.logsDir });
    await ensureDir(this.logsDir);
    this._logIO("创建/检查工作树目录", { path: this.worktreesDir });
    await ensureDir(this.worktreesDir);
    this.config = await this._loadConfig();
    const [globalObjective, agentsExcerpt] = await this._loadAgentsContext();
    this.globalObjective = globalObjective;
    this.agentsExcerpt = agentsExcerpt;
    const runtimePath = path.join(this.stateDir, "evolution_runtime.json");
    try {
      this._logIO("检查运行时文件是否存在", { path: runtimePath });
      await fs.access(runtimePath);
    } catch {
      const runtime = { cycle: 0, successful_promotions: 0, failed_cycles: 0, last_tool: "", history: [] as any[] };
      this._logIO("初始化运行时文件", { path: runtimePath });
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
    this._logIO("读取运行时文件", { path: runtimePath });
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
    // Persistent worker slot for LLM cache reuse
    const worktree = path.join(this.worktreesDir, "dao-1");
    
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
      if (changedFiles.length > 0) {
        this.tui.addLog(chalk.cyan.bold("Detected Changes:"));
        for (const f of changedFiles) {
          this.tui.addLog(chalk.cyan(`  - ${f}`));
        }
      }
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
      
      // Perform health check for observability
      const healthHistory = (runtime.history || []).map((h: any) => ({ status: h.status, tool: h.tool }));
      const health = checkEvolutionHealth(healthHistory);
      logHealthCheck(this.logger, health);
      
      this._logIO("写入运行时文件", { path: runtimePath });
      await writeJson(runtimePath, runtime);
    }
    return true;
  }

  async _checkMainRepoClean(): Promise<[boolean, string]> {
    this._logCommand("git status --porcelain");
    const cp = spawnSync("git", ["status", "--porcelain"], { cwd: this.root, encoding: "utf-8" });
    if (cp.status !== 0) return [false, cp.stderr?.trim() || "git status 失败"];
    if (cp.stdout.trim()) {
      const msg = "主仓库存在未提交改动，将尝试带脏合并 (Dirty Merge Mode)";
      this.tui.addLog(chalk.yellow(`[WARN] ${msg}`));
      return [true, msg];
    }
    return [true, "ok"];
  }

  async _availableTools(): Promise<ToolSpec[]> {
    const out: ToolSpec[] = [];
    for (const t of this.config.toolchain) {
      this._logCommand(`bash -lc ${t.check_cmd}`, { tool: t.name });
      const cp = spawnSync("bash", ["-lc", t.check_cmd], { cwd: this.root, encoding: "utf-8" });
      if ((cp.status ?? 1) === 0) out.push(t);
    }
    return out;
  }

  async _ensureGitHead(): Promise<[boolean, string]> {
    this._logCommand("git rev-parse --verify HEAD");
    const cp = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: this.root, encoding: "utf-8" });
    if ((cp.status ?? 1) === 0) return [true, "ok"];
    const addTargets = ["README.md", "config", "src", "pyproject.toml", "uv.lock"];
    const existing = addTargets.filter(p => fs.access(path.join(this.root, p)).then(() => true).catch(() => false));
    const resolved = await Promise.all(existing);
    const present = addTargets.filter((_, i) => resolved[i]);
    
    this._logCommand(`git add ${present.join(" ")}`);
    const add = spawnSync("git", ["add", ...present], { cwd: this.root, encoding: "utf-8" });
    if ((add.status ?? 1) !== 0) return [false, add.stderr?.trim() || "初始化 add 失败"];
    
    const commitMsg = "chore: bootstrap autonomous evolution core";
    this._logCommand(`git commit -m "${commitMsg}"`);
    const commit = spawnSync("git", ["commit", "-m", commitMsg], { cwd: this.root, encoding: "utf-8" });
    if ((commit.status ?? 1) !== 0) {
      const detail = `${commit.stdout}\n${commit.stderr}`.trim();
      return [false, `初始化提交失败: ${detail.slice(0, 260)}`];
    }
    return [true, "bootstrap commit created"];
  }

  async _createWorktree(branch: string, p: string): Promise<boolean> {
    try {
      // Check if the worktree directory already exists
      await fs.access(p);
      
      // If it exists, sync it to current main immediately
      // This is much faster than deleting and re-creating
      this._logCommand("git merge --abort", { cwd: p });
      spawnSync("git", ["merge", "--abort"], { cwd: p });
      this._logCommand("git reset --hard", { cwd: p });
      spawnSync("git", ["reset", "--hard"], { cwd: p });
      
      // Checkout the new branch based on the LATEST main
      this._logCommand(`git checkout -B ${branch} main`, { cwd: p });
      const cp = spawnSync("git", ["checkout", "-B", branch, "main"], { cwd: p, encoding: "utf-8" });
      if (cp.status === 0) return true;
      
      // If somehow checkout -B failed (e.g. main not found), fallback to re-add
      this._logCommand(`git worktree remove --force ${p}`);
      spawnSync("git", ["worktree", "remove", "--force", p], { cwd: this.root });
    } catch {}

    // Create fresh worktree based on main
    this._logCommand(`git worktree add -b ${branch} ${p} main`);
    const cp = spawnSync("git", ["worktree", "add", "-b", branch, p, "main"], { cwd: this.root, encoding: "utf-8" });
    return (cp.status ?? 1) === 0;
  }

  async _buildPromptFile(worktree: string, cycle: number, objective: string): Promise<string> {
    const runtimePath = path.join(this.stateDir, "evolution_runtime.json");
    this._logIO("读取运行时文件以构建提示", { path: runtimePath });
    const runtime = await readJson<any>(runtimePath);
    
    // Get list of files in allowed edit roots to help LLM skip exploration
    let allowedFiles: string[] = [];
    for (const root of this.config.allowed_edit_roots) {
      try {
        const cmdArgs = [root, "-maxdepth", "2", "-not", "-path", "*/.*"];
        this._logCommand(`find ${cmdArgs.join(" ")}`, { cwd: worktree });
        const cp = spawnSync("find", cmdArgs, { cwd: worktree, encoding: "utf-8" });
        if (cp.status === 0) {
          allowedFiles = allowedFiles.concat(cp.stdout.split("\n").filter(Boolean));
        }
      } catch {}
    }

    const summary = {
      cycle,
      global_objective: this.globalObjective,
      objective,
      history_tail: (runtime.history || []).slice(-5),
      allowed_files_preview: allowedFiles.slice(0, 50),
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
      `当前允许修改的目录及文件预览：\n${allowedFiles.join("\n")}\n\n` +
      `上下文：\n${JSON.stringify(summary, null, 2)}\n`;
    const tmpDir = path.join(os.tmpdir(), "dao_evo_prompts");
    this._logIO("创建/检查临时提示目录", { path: tmpDir });
    await ensureDir(tmpDir);
    const file = path.join(tmpDir, `evo_prompt_cycle_${cycle}.txt`);
    this._logIO("写入提示文件", { path: file });
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
      this._logIO("读取提示文件内容", { path: promptFile });
      promptText = await fs.readFile(promptFile, "utf-8");
    } catch {
      promptText = "";
    }
    const env = { 
      ...(process as any).env, 
      LC_ALL: "C", 
      LANG: "C",
      FORCE_COLOR: "1",
      TERM: "dumb",
      CI: "true",
      NODE_ENV: "test"
    };
    this.tui.setSubTask(tool.name, "running");
    
    this._logCommand(`bash -lc ${cmd}`, { cwd: worktree, tool: tool.name });
    const proc = spawn("bash", ["-lc", cmd], { 
      cwd: worktree, 
      env, 
      stdio: ["ignore", "pipe", "pipe"] 
    });
    
    const lines: string[] = [];
    let timedOut = false;
    let timeoutReason = "";
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
        timeoutReason = `Inactivity ${this.config.inactivity_timeout_sec}s`;
        this.tui.addLog(chalk.red(`[Timeout] ${timeoutReason}`));
        try { proc.kill(); } catch {}
        clearInterval(timer);
      } else if (totalElapsed > totalTimeoutMs) {
        timedOut = true;
        timeoutReason = `Total ${this.config.total_timeout_sec}s`;
        this.tui.addLog(chalk.red(`[Timeout] ${timeoutReason}`));
        try { proc.kill(); } catch {}
        clearInterval(timer);
      }
    }, 500);

    const processStream = (data: Buffer, stream: "stdout" | "stderr") => {
      lastOutputTime = Date.now();
      const raw = data.toString();

      // Always log raw to tracer for full traceability
      this._toolStream(cycle, tool.name, stream, raw.trim());

      // Split into lines
      const parts = raw.split(/\r?\n/);
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // Use human-readable formatter for TUI display
        const formatted = this._formatToolLog(tool.name, tool.parser, stream, trimmed);
        
        lines.push(trimmed); // Keep raw for internal collection
        if (formatted) {
          if (formatted.isDelta) {
            this.tui.appendLog(formatted.text);
          } else {
            this.tui.addLog(formatted.text);
          }
        } else {
          // FALLBACK: If not JSON, show it with stream prefix. 
          // Use red for stderr, gray for stdout.
          const prefix = stream === "stderr" ? chalk.red(`[${stream}] `) : chalk.gray(`[${stream}] `);
          this.tui.addLog(prefix + chalk.dim(trimmed));
        }
      }
    };

    proc.stdout.on("data", (d: Buffer) => processStream(d, "stdout"));
    proc.stderr.on("data", (d: Buffer) => processStream(d, "stderr"));

    this._toolStream(cycle, tool.name, "cmd", `bash -lc ${cmd}`);
    if (promptText) this._toolStream(cycle, tool.name, "prompt", promptText.split(/\s+/).join(" ").slice(0, 220));
    const rc: number = await new Promise(resolve => proc.on("close", (code: any) => resolve(Number(code ?? 1))));
    clearInterval(timer);
    
    const ok = (rc === 0 || lines.length > 10) && !timedOut;
    const status = ok ? "success" : "fail";
    const failReason = timedOut ? timeoutReason : (rc !== 0 ? `Exit ${rc}` : undefined);
    this.tui.setSubTask(tool.name, status, failReason);
    
    return [ok, lines.join("\n")];
  }

  async _changedFiles(worktree: string): Promise<string[]> {
    this._logCommand("git status --porcelain", { cwd: worktree });
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
      this._logCommand(`bash -lc ${cmd}`, { cwd: worktree });
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
    this._logCommand("git add -A", { cwd: worktree });
    const add = spawnSync("git", ["add", "-A"], { cwd: worktree, encoding: "utf-8" });
    if ((add.status ?? 1) !== 0) return [false, add.stderr?.trim() || "git add 失败"];
    const msg = `auto(evo): cycle=${cycle} tool=${toolName} score=${score.toFixed(3)} obj=${objective.slice(0, 40)}`;
    this._logCommand(`git commit -m "${msg}"`, { cwd: worktree });
    const commit = spawnSync("git", ["commit", "-m", msg], { cwd: worktree, encoding: "utf-8" });
    if ((commit.status ?? 1) !== 0) {
      const output = `${commit.stdout}\n${commit.stderr}`.trim().slice(0, 300);
      return [false, output];
    }
    return [true, msg];
  }

  async _mergeBranch(branch: string): Promise<[boolean, string]> {
    this._logCommand(`git merge --ff-only ${branch}`);
    let cp = spawnSync("git", ["merge", "--ff-only", branch], { cwd: this.root, encoding: "utf-8" });
    
    if (cp.status !== 0) {
      this.tui.addLog(chalk.yellow("[INFO] 合并受阻，尝试使用 stash 保护现场并重新合并..."));
      // Push current changes to stash
      spawnSync("git", ["stash", "push", "-m", `auto-evo-stash-${Date.now()}`], { cwd: this.root });
      
      // Retry merge
      cp = spawnSync("git", ["merge", "--ff-only", branch], { cwd: this.root, encoding: "utf-8" });
      
      // Always try to pop back
      spawnSync("git", ["stash", "pop"], { cwd: this.root });
    }

    const out = `${cp.stdout}\n${cp.stderr}`.trim();
    return [(cp.status ?? 1) === 0, out.slice(0, 300)];
  }

  async _cleanupWorktree(worktree: string, branch: string): Promise<void> {
    try {
      // Soft cleanup: reset state but KEEP the directory and LLM caches
      this._logCommand("git reset --hard HEAD", { cwd: worktree });
      spawnSync("git", ["reset", "--hard", "HEAD"], { cwd: worktree });
      this._logCommand("git clean -fd", { cwd: worktree });
      spawnSync("git", ["clean", "-fd"], { cwd: worktree });
      // Detach HEAD so the branch is no longer "in use" by this worktree
      this._logCommand("git checkout --detach", { cwd: worktree });
      spawnSync("git", ["checkout", "--detach"], { cwd: worktree });
    } catch {}
    
    // Delete the temporary branch in main repo to keep it clean
    this._logCommand(`git branch -D ${branch}`);
    spawnSync("git", ["branch", "-D", branch], { cwd: this.root });
  }

  _logCommand(cmd: string, detail: Record<string, any> = {}): void {
    const cwd = detail.cwd || this.root;
    const msg = `[CMD] ${cmd} (in ${path.relative(this.root, cwd) || "."})`;
    this.tui.addLog(chalk.blue(msg));
    this._trace(0, "EXEC", msg, { cmd, ...detail });
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
      this._logIO("检查计划文件是否存在", { path: p });
      await fs.access(p);
    } catch {
      this._logIO("初始化计划文件", { path: p });
      await writeJson(p, this._defaultPlan());
    }
  }

  async _readPlan(): Promise<any> {
    const p = this._planPath();
    try {
      this._logIO("读取计划文件", { path: p });
      await fs.access(p);
      return await readJson<any>(p);
    } catch (err) {
      if ((err as any).code !== "ENOENT") {
        this._logIO("计划文件异常，备份并重置", { path: p });
        const backup = await backupFile(p);
        logException(this.logger, err, `Plan file corrupted. Backed up to ${backup}. Resetting to default.`);
      }
      const plan = this._defaultPlan();
      this._logIO("写入默认计划文件", { path: p });
      await writeJson(p, plan);
      return plan;
    }
  }

  async _writePlan(plan: any): Promise<void> {
    const p = this._planPath();
    try {
      plan.updated_at = nowIso();
      this._logIO("写入计划文件", { path: p });
      await writeJson(p, plan);
    } catch (err) {
      logException(this.logger, err, `Failed to write plan to ${p}`);
      throw err;
    }
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
      this._logIO("读取 AGENTS.md", { path: this.agentsPath });
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
    this._logIO("写入实时状态文件", { path: path.join(this.stateDir, "evolution_live.json"), phase, message });
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

  /**
   * Extract human-readable summary from tool stream output
   * Based on actual stream-json format from qwen/codebuddy/gemini CLI tools
   * 
   * Observed formats:
   * 
   * qwen/codebuddy (v0.12.0):
   * - {"type":"system", ...} - system init info
   * - {"type":"stream_event", "event":{"type":"message_start"| "content_block_delta"|...}} - streaming events
   * - {"type":"assistant", "message":{"role":"assistant", "content":[...]}} - complete assistant message
   * - {"type":"result", ...} - final result
   * 
   * gemini:
   * - {"type":"init", ...} - session init
   * - {"type":"message", "role":"user"|"assistant", "content":"...", "delta":true} - streaming messages
   * - {"type":"result", "status":"success", ...} - final result
   */
  _formatToolLog(toolName: string, toolParser: string | undefined, stream: string, text: string): { text: string; isDelta: boolean } | null {
    // Try to parse JSON for structured tools
    const name = (toolParser || toolName || "").toLowerCase();
    if (name === "qwen" || name === "codebuddy" || name === "gemini") {
      try {
        const obj = JSON.parse(text);
        const type = obj?.type as string;

        // === GEMINI FORMAT ===
        if (name === "gemini") {
          // Skip init messages
          if (type === "init") return null;
          
          // Handle streaming messages
          if (type === "message") {
            const role = obj?.role as string;
            const content = String(obj?.content || "");
            const isDelta = obj?.delta as boolean;
            
            if (role === "assistant" && content) {
              return { text: isDelta ? content : `[${role}] ${content}`, isDelta };
            }
            if (role === "user") return null; // Skip user echo
          }

          // Handle tool calls
          if (type === "call") {
            const call = obj?.call;
            const callName = call?.function?.name || call?.name;
            const args = call?.function?.arguments || call?.args || {};
            const target = args.file_path || args.path || args.dest || "";
            return { text: chalk.yellow.bold(`\n[CALL] ${callName}(${target})\n`), isDelta: false };
          }
          
          // Handle result
          if (type === "result") {
            const status = obj?.status || "done";
            return { text: chalk.green.bold(`\n[Result] ${status}\n`), isDelta: false };
          }
          
          return null;
        }

        // === QWEN/CODEBUDDY FORMAT ===
        if (type === "system") return null;

        // Handle stream_event messages (most common during streaming)
        if (type === "stream_event") {
          const event = obj?.event;
          const eventType = event?.type as string;

          if (eventType === "content_block_delta") {
            const delta = event?.delta;
            const deltaType = delta?.type as string;
            if (deltaType === "text_delta") {
              return { text: delta.text || "", isDelta: true };
            } else if (deltaType === "thinking_delta") {
              return { text: chalk.dim(delta.thinking || ""), isDelta: true };
            }
            return null;
          }

          if (eventType === "tool_call_delta") {
            const call = event?.delta?.tool_call;
            if (call?.name) return { text: chalk.yellow.bold(`\n[CALL] ${call.name}`), isDelta: false };
            if (call?.arguments) return { text: chalk.yellow(call.arguments), isDelta: true };
            return null;
          }

          if (eventType === "message_start" || 
              eventType === "content_block_start" || 
              eventType === "content_block_stop" ||
              eventType === "message_stop") {
            return null;
          }
        }

        // Handle assistant messages (complete message snapshots)
        if (type === "assistant") {
          const message = obj?.message;
          const role = message?.role as string;
          const content = message?.content as any[];
          if (!content) return null;

          for (const block of content) {
            if (block.type === "text") {
              return { text: block.text || "", isDelta: false };
            }
            if (block.type === "tool_use") {
              const target = block.input?.file_path || block.input?.path || "";
              return { text: chalk.yellow.bold(`\n[TOOL] ${block.name}(${target})\n`), isDelta: false };
            }
          }
          return null;
        }

        // Handle final result
        if (type === "result") {
          const result = String(obj?.result || "ok");
          const duration = obj?.duration_ms ? `${Math.round(obj.duration_ms)}ms` : "";
          return { text: chalk.green.bold(`\n[Result] ${result}${duration ? ` (${duration})` : ""}\n`), isDelta: false };
        }

        const content = this._extractStreamText(obj);
        if (content && content.trim()) {
          return { text: content, isDelta: false };
        }

        return null;

      } catch {
        // Not JSON, fall through to plain text
      }
    }

    const cleaned = text.split(/\s+/).join(" ").trim();
    return cleaned ? { text: cleaned, isDelta: false } : null;
  }

  _emitConsoleLog(channel: string, payload: Record<string, any>): void {
    if (process.stdout.isTTY) return; // Don't spam console if TUI is active
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

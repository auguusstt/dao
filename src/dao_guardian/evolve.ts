import path from "path";
import { promises as fs } from "fs";
import { spawn, spawnSync, ChildProcess } from "child_process";
import os from "os";
import chalk from "chalk";
import { TUI, Text, ProcessTerminal, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readJson, writeJson, appendJsonl, nowIso, ensureDir, backupFile } from "../common/fs.js";
import { setupLogger, logSummary, logException, checkEvolutionHealth, logHealthCheck, logToolFailure, ToolFailureAnalysis, HealthCheckResult } from "./logging_utils.js";
import { DaoPlanner, PlanResult } from "./planner.js";
import { getTracer } from "./tracing.js";
import { Span, SpanStatusCode, trace, Context } from "@opentelemetry/api";

type ToolSpec = { name: string; check_cmd: string; run_cmd: string; parser?: string };

type EvolutionConfig = {
  objectives: string[];
  validate_commands: string[];
  protected_paths: string[];
  allowed_edit_roots: string[];
  toolchain: ToolSpec[];
  enabled_tools?: string[];
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
  private health?: HealthCheckResult;
  private subTasks: SubTask[] = [];
  private isTTY: boolean;
  private lastFooterHeight: number = 0;
  private onExitCallback?: () => void;

  constructor() {
    this.isTTY = process.stdout.isTTY;
    if (this.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (key: string) => {
        // Ctrl+C (unicode \u0003) or 'q'
        if (key === "\u0003" || key === "q") {
          this.restoreTTY();
          if (this.onExitCallback) this.onExitCallback();
          else process.exit(0);
        }
      });
    }
  }

  restoreTTY() {
    if (this.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }

  onExit(cb: () => void) {
    this.onExitCallback = cb;
  }

  updateStatus(cycle: number, objective: string, phase: string, message: string, health?: HealthCheckResult) {
    this.cycle = cycle;
    this.objective = objective;
    this.phase = phase;
    this.message = message;
    if (health) this.health = health;
    if (phase === "START") {
      this.subTasks = [];
    }
    this.render();
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
    this.render();
  }

  addLog(text: string) {
    this.clearFooter();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      process.stdout.write("  " + line + "\n");
    }
    this.render();
  }

  appendLog(text: string) {
    this.clearFooter();
    process.stdout.write(text);
    this.render();
  }

  private clearFooter() {
    if (!this.isTTY || this.lastFooterHeight <= 0) return;
    process.stdout.write(`\x1b[${this.lastFooterHeight}A\x1b[J`);
    this.lastFooterHeight = 0;
  }

  private render() {
    if (!this.isTTY) return;
    this.clearFooter();

    const width = process.stdout.columns || 80;
    const footerLines: string[] = [];
    
    footerLines.push(chalk.cyan.bold("\n═══ DAO Evolution Terminal ═══"));
    footerLines.push(chalk.white("─".repeat(Math.min(50, width))));
    
    let healthInfo = "";
    if (this.health) {
      const hColor = this.health.status === "healthy" ? chalk.greenBright : (this.health.status === "degraded" ? chalk.yellowBright : chalk.redBright);
      healthInfo = `${chalk.white("│")} ${chalk.yellowBright("Health:")} ${hColor(this.health.status)} (${(this.health.success_rate * 100).toFixed(1)}%) `;
    }
    const statusLine = `${chalk.yellowBright("Cycle:")} ${chalk.whiteBright(this.cycle)}  ${chalk.white("│")}  ${chalk.yellowBright("Phase:")} ${chalk.bold.greenBright(this.phase)}  ${healthInfo}${chalk.white("│")}  ${chalk.cyanBright(this.message)}`;
    footerLines.push(truncateToWidth(statusLine, width));
    
    if (this.health && this.health.status !== "healthy" && this.health.suggestion) {
      footerLines.push(chalk.yellowBright(`[Sug] ${this.health.suggestion}`));
    } else {
      footerLines.push(chalk.white("─".repeat(Math.min(50, width))));
    }
    
    footerLines.push(chalk.blueBright.bold("进度树 Progress Tree:"));
    const phases = [
      "START", "PLANNING", "ENSURE_HEAD", "CHECK_CLEAN", "CHECK_TOOLS",
      "CREATE_WORKTREE", "RUN_TOOL", "SELF_HEAL", "VALIDATE", "COMMIT", "MERGE", "DONE"
    ];
    let foundCurrent = false;
    for (const p of phases) {
      const isCurrent = p === this.phase;
      if (isCurrent) {
        footerLines.push(`${chalk.greenBright(" ●")} ${chalk.bold.whiteBright(p)}`);
        foundCurrent = true;
      } else if (!foundCurrent) {
        footerLines.push(`${chalk.greenBright(" ✓")} ${chalk.white(p)}`);
      } else {
        footerLines.push(`${chalk.white(" ○")} ${chalk.white(p)}`);
      }
      const tasksInPhase = this.subTasks.filter(st => st.phase === p);
      for (const st of tasksInPhase) {
        const icon = st.status === "success" ? chalk.greenBright("✓") :
                     st.status === "fail" ? chalk.redBright("✗") :
                     st.status === "running" ? chalk.yellowBright("⟳") : chalk.white("○");
        let meta = "";
        if (st.status === "running" && st.startTime) {
          const elapsed = Math.floor((Date.now() - st.startTime) / 1000);
          meta = chalk.yellowBright(` (${elapsed}s)`);
        } else if (st.reason) {
          meta = chalk.redBright(` (${st.reason})`);
        }
        footerLines.push(`   ${icon} ${chalk.white(st.name)}${meta}`);
      }
    }

    const footer = footerLines.join("\n") + "\n";
    process.stdout.write(footer);
    this.lastFooterHeight = footerLines.length + 1;
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
  planner: DaoPlanner;
  private tracer = getTracer();
  private _currentToolProc: ChildProcess | null = null;

  constructor(root: string) {
    this.root = root;
    this.configDir = path.join(root, "config");
    this.stateDir = path.join(root, "state");
    this.logsDir = path.join(root, "logs");
    this.worktreesDir = path.join(root, ".worktrees");
    this.agentsPath = path.join(root, "AGENTS.md");
    this.planner = new DaoPlanner(root);
  }

  _logIO(msg: string, detail: Record<string, any> = {}): void {
    this.tui.addLog(chalk.cyan(`[IO] ${msg}`));
    this._trace(0, "IO", msg, detail);
  }

  _logCommand(cmd: string, detail: Record<string, any> = {}): void {
    const cwd = detail.cwd || this.root;
    const msg = `[CMD] ${cmd} (in ${path.relative(this.root, cwd) || "."})`;
    this.tui.addLog(chalk.blueBright(msg));
    this._trace(0, "EXEC", msg, { cmd, ...detail });
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

  async _loadConfig(): Promise<EvolutionConfig> {
    const p = path.join(this.configDir, "evolution.json");
    try {
      this._logIO(`读取配置: ${p}`);
      const raw = await readJson<any>(p);
      return {
        objectives: raw.objectives || [],
        validate_commands: raw.validate_commands || [],
        protected_paths: raw.protected_paths || [],
        allowed_edit_roots: raw.allowed_edit_roots || [],
        toolchain: raw.toolchain || [],
        enabled_tools: raw.enabled_tools,
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
    this._logIO("初始化目录结构...");
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
      this._logIO(`创建新运行时文件: ${runtimePath}`);
      await writeJson(runtimePath, runtime);
    }
    await this._initPlanIfMissing();
  }

  async run(cycles: number, sleepSeconds: number): Promise<void> {
    await this.bootstrap();

    let isExiting = false;
    const exitGracefully = () => {
      if (isExiting) return;
      isExiting = true;
      this.tui.restoreTTY();
      this.tui.addLog(chalk.yellowBright("\n[EXIT] 接收到退出信号，正在安全关闭并清理所有子进程..."));
      
      this.planner.cleanup();
      if (this._currentToolProc && this._currentToolProc.pid) {
        try { process.kill(-this._currentToolProc.pid, "SIGKILL"); } catch {}
      }
      
      process.exit(0);
    };

    this.tui.onExit(exitGracefully);
    process.on("SIGINT", exitGracefully);
    process.on("SIGTERM", exitGracefully);

    for (let i = 0; i < cycles; i++) {
      const cont = await this.runOnce();
      if (!cont) {
        this.tui.addLog(chalk.redBright.bold("\n[STOP] 进化循环检测到关键故障，已主动停止。"));
        break;
      }
      if (sleepSeconds > 0) {
        this.tui.addLog(chalk.dim(`休眠 ${sleepSeconds} 秒待进入下一周期...`));
        await new Promise(r => setTimeout(r, sleepSeconds * 1000));
      }
    }
  }

  async runOnce(): Promise<boolean> {
    const runtimePath = path.join(this.stateDir, "evolution_runtime.json");
    const runtime = await readJson<any>(runtimePath);
    runtime.cycle = Number(runtime.cycle) + 1;
    const cycle = Number(runtime.cycle);

    return this.tracer.startActiveSpan(`Cycle ${cycle}`, async (span: Span) => {
      const cycleStarted = Date.now();

      const getHealth = () => {
        const healthHistory = (runtime.history || []).map((h: any) => ({ status: h.status, tool: h.tool }));
        return checkEvolutionHealth(healthHistory);
      };

      const updateUI = (phase: string, msg: string, obj: string = "...") => {
        this.tui.updateStatus(cycle, obj, phase, msg, getHealth());
        span.addEvent("Phase Change", { phase, message: msg });
      };

      try {
        // 检查是否连续验证失败
        const history = runtime.history || [];
        const recentValidations = history.slice(-5).filter((h: any) => h.reason?.includes("校验未通过"));
        if (recentValidations.length >= 5) {
          const msg = "连续 5 次验证失败，怀疑核心构建逻辑损坏";
          this.tui.addLog(chalk.redBright.bold(`\n[CRITICAL] ${msg}，请人工修复。`));
          span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
          span.end();
          return false;
        }

        updateUI("START", "开始新一轮进化");
        await this._setLiveStatus(cycle, "START", "开始新一轮进化");
        await this._trace(cycle, "START", "开始新一轮进化", {});

        updateUI("CHECK_TOOLS", "检测工具链");
        const tools = await this._availableTools();
        if (tools.length === 0) {
          const reason = "未检测到可用工具，请检查 evolution.json";
          runtime.failed_cycles += 1;
          this._record(runtime, cycle, "FAIL", reason, 0.0, "");
          await writeJson(runtimePath, runtime);
          updateUI("FAIL", reason);
          span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
          span.end();
          return false;
        }

        updateUI("PLANNING", "生成本轮进化目标");
        const [objective, plan] = await this._nextObjective(runtime, tools);
        updateUI("PLANNING", "规划完成", objective);
        span.setAttributes({ objective });

        updateUI("ENSURE_HEAD", "同步 Git 状态", objective);
        const [headOk, headReason] = await this._ensureGitHead();
        if (!headOk) {
          runtime.failed_cycles += 1;
          this._record(runtime, cycle, "FAIL", headReason, 0.0, "");
          await writeJson(runtimePath, runtime);
          updateUI("FAIL", headReason, objective);
          span.setStatus({ code: SpanStatusCode.ERROR, message: headReason });
          span.end();
          return false;
        }

        updateUI("CHECK_CLEAN", "检查工作区", objective);
        const [okClean, cleanReason] = await this._checkMainRepoClean();
        if (!okClean) {
          this._record(runtime, cycle, "SKIP", cleanReason, 0.0, "");
          await writeJson(runtimePath, runtime);
          updateUI("SKIP", cleanReason, objective);
          span.end();
          return false;
        }

        const tool = tools[(cycle - 1) % tools.length];
        const branch = `auto/evo-${new Date().toISOString().replace(/[:.]/g, "-")}-${cycle}`;
        const worktree = path.join(this.worktreesDir, "dao-1");
        
        span.setAttributes({ "tool.name": tool.name, "git.branch": branch });
        await this._trace(cycle, "PLAN", "已选择工具与目标", {
          tool: tool.name,
          objective,
          branch
        });

        updateUI("CREATE_WORKTREE", "创建隔离环境");
        const created = await this._createWorktree(branch, worktree);
        if (!created) {
          runtime.failed_cycles += 1;
          this._record(runtime, cycle, "FAIL", "隔离环境创建失败", 0.0, tool.name);
          await writeJson(runtimePath, runtime);
          updateUI("FAIL", "隔离环境创建失败");
          span.setStatus({ code: SpanStatusCode.ERROR, message: "隔离环境创建失败" });
          span.end();
          return false;
        }

        try {
          updateUI("RUN_TOOL", `执行智能进化: ${tool.name}`, objective);
          const promptFile = await this._buildPromptFile(worktree, cycle, objective);
          let [toolOk, toolOut] = await this._runTool(cycle, tool, worktree, promptFile);
          
          let [validateOk, validateDetail] = await this._validate(worktree);
          
          if (!validateOk && toolOk) {
            updateUI("SELF_HEAL", "验证失败，启动自我修复...", objective);
            this.tui.addLog(chalk.yellowBright(`[Self-Heal] 检测到验证失败，正在将错误反馈给 Agent 修复...`));
            
            const healPrompt = `你的改动在验证阶段失败了。请修复以下错误：\n\n${validateDetail}\n\n只返回修复后的代码或针对错误的补丁。`;
            const healFile = path.join(os.tmpdir(), `heal_prompt_${cycle}.txt`);
            await fs.writeFile(healFile, healPrompt, "utf-8");
            
            const [healOk, healOut] = await this._runTool(cycle, tool, worktree, healFile);
            toolOk = healOk;
            toolOut = healOut; // Ensure toolOut is also updated if needed
            const [v2Ok, v2Detail] = await this._validate(worktree);
            validateOk = v2Ok;
            validateDetail = v2Detail;
            
            if (validateOk) this.tui.addLog(chalk.greenBright(`[Self-Heal] 自我修复成功！`));
            else this.tui.addLog(chalk.redBright(`[Self-Heal] 自提修复后验证仍失败。`));
          }

          updateUI("VALIDATE", "执行最终护栏检查", objective);
          const changedFiles = await this._changedFiles(worktree);
          if (changedFiles.length > 0) {
            this.tui.addLog(chalk.greenBright.bold(`检测到文件变动 (${changedFiles.length} 个):`));
            for (const f of changedFiles) this.tui.addLog(chalk.greenBright(`  - ${f}`));
          }

          const [guardOk, guardReason] = this._guardChanges(changedFiles);
          if (!guardOk && changedFiles.length > 0) this.tui.addLog(chalk.redBright(`[GUARD] 护栏拦截: ${guardReason}`));

          const score = this._score(toolOk, changedFiles, guardOk, validateOk);
          await this._trace(cycle, "EVAL", "评分结果", { score, changed: changedFiles.length, guard_ok: guardOk, validate_ok: validateOk });

          if (toolOk && changedFiles.length && guardOk && validateOk && score >= this.config.min_score_promote) {
            updateUI("COMMIT", "准备提交", objective);
            const [commitOk, commitMsg] = await this._commitCandidate(worktree, cycle, objective, tool.name, score);
            let mergeOk = false;
            let mergeMsg = "未执行 merge";
            if (commitOk) {
              updateUI("MERGE", "合并到主分支", objective);
              const r = await this._mergeBranch(branch);
              mergeOk = r[0];
              mergeMsg = r[1];
            }
            if (commitOk && mergeOk) {
              runtime.successful_promotions += 1;
              runtime.last_tool = tool.name;
              this._record(runtime, cycle, "PROMOTED", `晋升成功: ${mergeMsg}`, score, tool.name, changedFiles.length);
              updateUI("DONE", "进化成功并合并", objective);
              span.setStatus({ code: SpanStatusCode.OK });
            } else {
              runtime.failed_cycles += 1;
              this._record(runtime, cycle, "FAIL", `提交/合并失败: ${commitMsg} / ${mergeMsg}`, score, tool.name, changedFiles.length);
              updateUI("FAIL", "提交/合并受阻");
              span.setStatus({ code: SpanStatusCode.ERROR, message: "提交/合并受阻" });
            }
          } else {
            const reason = !toolOk ? "工具执行失败" : (!changedFiles.length ? "无代码改动" : (!guardOk ? `护栏拒绝 (${guardReason})` : `验证失败或得分低 (${score.toFixed(2)})`));
            runtime.failed_cycles += 1;
            this._record(runtime, cycle, "FAIL", reason, score, tool.name, changedFiles.length);
            updateUI("FAIL", reason, objective);
            span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
            
            if (score < 0.5 && toolOk) {
              this.tui.addLog(chalk.redBright(`[WARNING] 低分进化尝试，已自动舍弃。`));
            }
          }
        } catch (err) {
          logException(this.logger, err, `Cycle ${cycle} crashed`);
          runtime.failed_cycles += 1;
          this._record(runtime, cycle, "FAIL", `系统崩溃: ${String(err)}`, 0.0, tool.name);
          updateUI("FAIL", "系统崩溃");
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        } finally {
          await writeJson(runtimePath, runtime);
          await this._cleanupWorktree(worktree, branch);
          span.end();
        }
      } catch (outerErr) {
        span.recordException(outerErr as Error);
        span.end();
        throw outerErr;
      }
      return true;
    });
  }

  async _availableTools(): Promise<ToolSpec[]> {
    const list: ToolSpec[] = [];
    for (const tool of this.config.toolchain) {
      if (this.config.enabled_tools && !this.config.enabled_tools.includes(tool.name)) continue;
      const cp = spawnSync("sh", ["-c", tool.check_cmd], { encoding: "utf-8" });
      if (cp.status === 0) list.push(tool);
    }
    return list;
  }

  async _ensureGitHead(): Promise<[boolean, string]> {
    const cp = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.root, encoding: "utf-8" });
    const branch = cp.stdout.trim();
    if (branch !== "main") {
       this.tui.addLog(chalk.yellow(`[GIT] 当前分支为 ${branch}，尝试切回 main...`));
       spawnSync("git", ["checkout", "main"], { cwd: this.root });
    }
    spawnSync("git", ["pull", "origin", "main"], { cwd: this.root });
    return [true, "ok"];
  }

  async _checkMainRepoClean(): Promise<[boolean, string]> {
    const cp = spawnSync("git", ["status", "--porcelain"], { cwd: this.root, encoding: "utf-8" });
    const out = cp.stdout.trim();
    if (out) {
       this.tui.addLog(chalk.yellowBright(`[!] 工作区不洁，进入 Dirty Merge 模式`));
       return [true, "dirty"];
    }
    return [true, "clean"];
  }

  async _initRepo(): Promise<[boolean, string]> {
    spawnSync("git", ["init"], { cwd: this.root });
    const addTargets = ["src", "package.json", "tsconfig.json", "config", "AGENTS.md", "README.md", "ROADMAP.md"];
    spawnSync("git", ["add", ...addTargets], { cwd: this.root });
    const commit = spawnSync("git", ["commit", "-m", "chore: bootstrap dao-ts"], { cwd: this.root, encoding: "utf-8" });
    return (commit.status ?? 1) === 0 ? [true, "bootstrapped"] : [false, "Git 初始化失败"];
  }

  async _createWorktree(branch: string, p: string): Promise<boolean> {
    this._logIO(`同步隔离环境: ${p}`);
    try {
      await fs.access(p);
      spawnSync("git", ["merge", "--abort"], { cwd: p });
      spawnSync("git", ["reset", "--hard", "HEAD"], { cwd: p });
      const cp = spawnSync("git", ["checkout", "-B", branch, "main"], { cwd: p, encoding: "utf-8" });
      if (cp.status === 0) return true;
      spawnSync("git", ["worktree", "remove", "--force", p], { cwd: this.root });
    } catch {}

    const cp = spawnSync("git", ["worktree", "add", "-b", branch, p, "main"], { cwd: this.root, encoding: "utf-8" });
    return (cp.status ?? 1) === 0;
  }

  async _buildPromptFile(worktree: string, cycle: number, objective: string): Promise<string> {
    let allowedFiles: string[] = [];
    for (const root of this.config.allowed_edit_roots) {
      const cp = spawnSync("find", [root, "-maxdepth", "2", "-not", "-path", "*/.*"], { cwd: worktree, encoding: "utf-8" });
      if (cp.status === 0) allowedFiles = allowedFiles.concat(cp.stdout.split("\n").filter(Boolean));
    }

    const prompt = `你是自主进化 Agent。目标：${objective}\n\n允许修改：\n${allowedFiles.join("\n")}\n\n限制：禁止触碰受保护目录 ${this.config.protected_paths.join(", ")}。改动必须通过校验。`;
    const tmpDir = path.join(os.tmpdir(), "dao_evo_prompts");
    await ensureDir(tmpDir);
    const file = path.join(tmpDir, `evo_prompt_cycle_${cycle}.txt`);
    await fs.writeFile(file, prompt, "utf-8");
    return file;
  }

  async _runTool(cycle: number, tool: ToolSpec, worktree: string, promptFile: string): Promise<[boolean, string]> {
    return this.tracer.startActiveSpan(`Tool: ${tool.name}`, async (span: Span): Promise<[boolean, string]> => {
      let cmd = tool.run_cmd;
      const replacements = { worktree, prompt_file: promptFile };
      for (const [k, v] of Object.entries(replacements)) cmd = cmd.split(`{${k}}`).join(v);
      
      span.setAttributes({
        "tool.name": tool.name,
        "tool.cmd": cmd,
        "tool.worktree": worktree
      });

      this.tui.setSubTask(tool.name, "running");
      this._logCommand(`sh -c "${cmd}"`, { cwd: worktree, tool: tool.name });
      
      const proc = spawn("sh", ["-c", cmd], { 
        cwd: worktree, 
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
      this._currentToolProc = proc;
      const lines: string[] = [];
      let lastOutput = Date.now();

      const timer = setInterval(() => {
        if (Date.now() - lastOutput > this.config.inactivity_timeout_sec * 1000) {
          const timeoutMsg = `工具 ${tool.name} 无响应已超过 ${this.config.inactivity_timeout_sec}s`;
          this.tui.addLog(chalk.redBright(`[TIMEOUT] ${timeoutMsg}`));
          span.addEvent("Timeout", { message: timeoutMsg });
          try { 
            if (proc.pid) process.kill(-proc.pid, "SIGKILL"); 
            else proc.kill("SIGKILL");
          } catch {}
          clearInterval(timer);
        }
      }, 1000);

      const processStream = (data: Buffer, stream: "stdout" | "stderr") => {
        lastOutput = Date.now();
        const raw = data.toString();
        this._toolStream(cycle, tool.name, stream, raw.trim());
        for (const line of raw.split(/\r?\n/).filter(l => l.trim())) {
          const formatted = this._formatToolLog(tool.name, tool.parser, stream, line);
          if (formatted) {
            if (formatted.isDelta) this.tui.appendLog(formatted.text);
            else this.tui.addLog(formatted.text);
          } else {
            this.tui.addLog(chalk.white(line.trim()));
          }
          lines.push(line);
        }
      };

      proc.stdout.on("data", (d: Buffer) => processStream(d, "stdout"));
      proc.stderr.on("data", (d: Buffer) => processStream(d, "stderr"));

      const rc = await new Promise<number>(resolve => {
        proc.on("close", (code: number | null) => {
          this._currentToolProc = null;
          resolve(code ?? 1);
        });
        proc.on("error", (err: Error) => {
          this._currentToolProc = null;
          span.recordException(err);
          resolve(1);
        });
      });
      clearInterval(timer);
      
      const ok = (rc === 0 || lines.length > 5);
      if (!ok) {
        this.tui.addLog(chalk.redBright(`[FAIL] 工具 ${tool.name} 执行异常 (Exit: ${rc})`));
        span.setStatus({ code: SpanStatusCode.ERROR, message: `Exit ${rc}` });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      this.tui.setSubTask(tool.name, ok ? "success" : "fail", rc !== 0 ? `Exit ${rc}` : undefined);
      span.end();
      return [ok, lines.join("\n")];
    });
  }

  async _changedFiles(worktree: string): Promise<string[]> {
    const cp = spawnSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf-8" });
    return cp.stdout.split("\n").filter((l: string) => l.trim()).map((l: string) => l.slice(3).trim());
  }

  _guardChanges(files: string[]): [boolean, string] {
    if (!files.length) return [false, "无变动"];
    for (const f of files) {
      if (this.config.protected_paths.some(p => f === p || f.startsWith(p + "/"))) return [false, `保护路径: ${f}`];
      if (!this.config.allowed_edit_roots.some(r => f === r || f.startsWith(r + "/"))) return [false, `未授权目录: ${f}`];
    }
    return [true, "ok"];
  }

  async _validate(worktree: string): Promise<[boolean, string]> {
    return this.tracer.startActiveSpan("Validate", async (span: Span): Promise<[boolean, string]> => {
      for (const cmd of this.config.validate_commands) {
        this._logCommand(`验证执行: ${cmd}`);
        span.addEvent("Running Validation", { command: cmd });
        const cp = spawnSync("sh", ["-c", cmd], { cwd: worktree, encoding: "utf-8" });
        if (cp.status !== 0) {
          const out = `${cp.stdout}\n${cp.stderr}`.trim();
          span.setStatus({ code: SpanStatusCode.ERROR, message: `Validation failed: ${cmd}` });
          span.setAttribute("error.output", out);
          span.end();
          return [false, `${cmd} 失败: ${out.slice(0, 1000)}`];
        }
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return [true, "ok"];
    });
  }

  _score(toolOk: boolean, changedFiles: string[], guardOk: boolean, validateOk: boolean): number {
    let s = 0;
    if (toolOk) s += 0.25;
    if (changedFiles.length) s += 0.25;
    if (guardOk) s += 0.25;
    if (validateOk) s += 0.25;
    return s;
  }

  async _commitCandidate(worktree: string, cycle: number, objective: string, toolName: string, score: number): Promise<[boolean, string]> {
    spawnSync("git", ["add", "-A"], { cwd: worktree });
    const msg = `auto(evo): cycle=${cycle} tool=${toolName} score=${score.toFixed(2)} obj=${objective.slice(0, 30)}`;
    const cp = spawnSync("git", ["commit", "-m", msg], { cwd: worktree, encoding: "utf-8" });
    return cp.status === 0 ? [true, msg] : [false, cp.stderr || "commit 失败"];
  }

  async _mergeBranch(branch: string): Promise<[boolean, string]> {
    this.tui.addLog(chalk.blueBright(`[MERGE] 正在合并分支 ${branch} 到 main...`));
    const cp = spawnSync("git", ["merge", "--ff-only", branch], { cwd: this.root, encoding: "utf-8" });
    return cp.status === 0 ? [true, "success"] : [false, "合并受阻"];
  }

  async _cleanupWorktree(worktree: string, branch: string): Promise<void> {
    spawnSync("git", ["reset", "--hard", "HEAD"], { cwd: worktree });
    spawnSync("git", ["clean", "-fd"], { cwd: worktree });
    spawnSync("git", ["branch", "-D", branch], { cwd: this.root });
  }

  _record(runtime: any, cycle: number, status: string, reason: string, score: number, toolName: string, changedCount: number = 0): void {
    const event = { ts: nowIso(), cycle, status, reason, score, tool: toolName, changed_count: changedCount };
    runtime.history.push(event);
    this._retrospectAndUpdatePlan(event);
    appendJsonl(path.join(this.logsDir, "evolution_events.jsonl"), event);
    logSummary(this.logger, { cycle, status, score, tool: toolName, reason, changed_count: changedCount });
  }

  async _initPlanIfMissing(): Promise<void> {
    try {
      await fs.access(this._planPath());
    } catch {
      this._logIO("初始化进化计划...");
      const plan = { updated_at: nowIso(), active_objective: this.config.objectives[0], objectives: this.config.objectives, next_actions: ["产出最小验证改动"] };
      await writeJson(this._planPath(), plan);
    }
  }

  _planPath(): string { return path.join(this.stateDir, "evolution_plan.json"); }

  async _readPlan(): Promise<any> { return readJson(this._planPath()); }

  async _writePlan(plan: any): Promise<void> {
    plan.updated_at = nowIso();
    await writeJson(this._planPath(), plan);
  }

  async _nextObjective(runtime: any, tools: ToolSpec[]): Promise<[string, any]> {
    const plan = await this._readPlan();
    const history = runtime.history || [];
    const lastEvent = history.length ? history[history.length - 1] : null;
    const consecutiveFails = history.slice(-3).filter((h: any) => h.status === "FAIL").length === 3;
    const shouldPlan = !plan.active_objective || lastEvent?.status === "PROMOTED" || consecutiveFails;

    if (shouldPlan && tools.length > 0) {
      const reason = !plan.active_objective ? "无活跃目标" : (lastEvent?.status === "PROMOTED" ? "晋升成功" : "连续失败");
      this.tui.addLog(chalk.magentaBright.bold(`\n[Planner] 触发智能规划 (原因: ${reason})`));
      const planTool = tools.find(t => ["qwen", "gemini"].includes(t.name)) || tools[0];
      const res = await this.planner.plan(planTool, m => this.tui.addLog(m));
      if (res) {
        plan.active_objective = res.next_objective;
        plan.next_actions = res.next_actions;
        this.tui.addLog(chalk.greenBright.bold(`[Planner] 规划成功！`));
        this.tui.addLog(chalk.greenBright.bold(`[Planner] 新目标: ${res.next_objective}`));
        await this._writePlan(plan);
      } else {
        this.tui.addLog(chalk.redBright.bold("[Planner] 规划工具执行彻底失败，无法自动生成目标。"));
        this.tui.addLog(chalk.yellowBright("[Fallback] 使用配置默认目标以尝试打破僵局..."));
      }
    }

    if (!plan.active_objective) {
      plan.active_objective = this.config.objectives[0];
      await this._writePlan(plan);
    }
    
    const nextActions = (plan.next_actions || []).map((i: any) => String(i).trim()).filter(Boolean);
    const objective = nextActions.length ? `${plan.active_objective} (动作: ${nextActions[0]})` : plan.active_objective;
    return [objective, plan];
  }

  async _retrospectAndUpdatePlan(event: any): Promise<void> {
    const plan = await this._readPlan();
    if (event.status === "PROMOTED") {
      plan.active_objective = ""; // Force re-plan
    } else {
      plan.next_actions = [event.reason.slice(0, 50)];
    }
    await this._writePlan(plan);
  }

  async _loadAgentsContext(): Promise<[string, string]> {
    const text = await fs.readFile(this.agentsPath, "utf-8");
    const m = text.match(/^总目标[：:]\s*(.+)$/m);
    return [m ? m[1].trim() : "进化系统", text.slice(0, 1000)];
  }

  async _setLiveStatus(cycle: number, phase: string, message: string): Promise<void> {
    await writeJson(path.join(this.stateDir, "evolution_live.json"), { cycle, phase, message, ts: nowIso() });
  }

  async _trace(cycle: number, phase: string, message: string, detail: Record<string, any>): Promise<void> {
    await appendJsonl(path.join(this.logsDir, "evolution_trace.jsonl"), { ts: nowIso(), cycle, phase, message, detail });
  }

  _toolStream(cycle: number, tool: string, stream: string, text: string): void {
    appendJsonl(path.join(this.logsDir, "evolution_tool_stream.jsonl"), { ts: nowIso(), cycle, tool, stream, text });
  }

  _formatToolLog(toolName: string, toolParser: string | undefined, stream: string, text: string): { text: string; isDelta: boolean } | null {
    const name = (toolParser || toolName || "").toLowerCase();
    try {
      const obj = JSON.parse(text);
      const type = obj?.type || obj?.subtype;
      if (type === "system" || type === "init") return { text: chalk.cyan(`[system] ${name} ready`), isDelta: false };
      
      if (type === "stream_event") {
        const delta = obj?.event?.delta;
        if (delta?.type === "text_delta") return { text: delta.text, isDelta: true };
        if (delta?.type === "thinking_delta") return { text: chalk.whiteBright(delta.thinking), isDelta: true };
        return null;
      }
      
      if (obj.type === "assistant") {
        const txt = obj.message?.content?.find((c: any) => c.type === "text")?.text;
        if (txt) return { text: chalk.white(txt), isDelta: false };
        const toolUse = obj.message?.content?.find((c: any) => c.type === "tool_use");
        if (toolUse) return { text: chalk.yellowBright.bold(`\n[TOOL] ${toolUse.name}(${toolUse.input?.path || ""})\n`), isDelta: false };
      }

      if (obj.type === "result") {
        const result = obj.result || "done";
        const turns = obj.num_turns || 0;
        const usage = obj.usage || {};
        const input = usage.input_tokens || 0;
        const output = usage.output_tokens || 0;
        
        let stats = chalk.greenBright.bold(`\n[Result] ${result}`);
        stats += chalk.white(`\n[Stats] Turns: ${turns} | Usage: ${input} in / ${output} out`);
        
        if (text.includes("quota")) {
          const quotaMatch = text.match(/quota[^]*/i);
          if (quotaMatch) stats += chalk.yellow(`\n[Quota] ${quotaMatch[0].split("\n")[0]}`);
        }
        
        return { text: stats + "\n", isDelta: false };
      }
      
      const content = this._extractStreamText(obj);
      return content ? { text: chalk.white(content), isDelta: false } : null;
    } catch {
      return { text: chalk.white(text), isDelta: false };
    }
  }
}

export async function printStatus(root: string, tail: number = 8): Promise<void> {
  console.log("=== DAO Evolution Status ===");
  try {
    const rt = await readJson<any>(path.join(root, "state", "evolution_runtime.json"));
    console.log(`Runtime: Cycle ${rt.cycle}, Promoted ${rt.successful_promotions}, Failed ${rt.failed_cycles}`);
    const history = rt.history || [];
    for (const e of history.slice(-tail)) {
      const color = e.status === "PROMOTED" ? chalk.green : (e.status === "FAIL" ? chalk.red : chalk.yellow);
      console.log(`${chalk.dim(e.ts)} [${color(e.status)}] ${e.tool} - ${e.reason}`);
    }
  } catch {
    console.log("No runtime data found.");
  }
}

import { Command } from "commander";
import path from "path";
import { promises as fs } from "fs";
import { setupLogger, logMetrics, generateCorrelationId, setGlobalCorrelationId, checkEvolutionHealth, logHealthCheck } from "./logging_utils.js";
import { readJson, writeJson, appendJsonl, nowIso, ensureDir } from "../common/fs.js";

const STATE_RUNNING = "RUNNING";
const STATE_DEGRADED = "DEGRADED";
const STATE_RECOVERY = "RECOVERY";

type Config = {
  topics: string[];
  degrade_threshold: number;
  evolve_every: number;
  keep_snapshots: number;
};

export class DaoGuardian {
  root: string;
  stateDir: string;
  dataDir: string;
  logsDir: string;
  configDir: string;
  config!: Config;
  logger = setupLogger("dao.guardian");

  constructor(root: string) {
    this.root = root;
    this.stateDir = path.join(root, "state");
    this.dataDir = path.join(root, "data");
    this.logsDir = path.join(root, "logs");
    this.configDir = path.join(root, "config");
  }

  async _loadConfig(): Promise<Config> {
    return await readJson<Config>(path.join(this.configDir, "goals.json"));
  }

  async bootstrap(): Promise<void> {
    const bootstrapStart = Date.now();
    await ensureDir(this.stateDir);
    await ensureDir(this.dataDir);
    await ensureDir(this.logsDir);
    this.config = await this._loadConfig();
    const bootstrapDurationMs = Date.now() - bootstrapStart;
    this.logger.info({ bootstrap_ms: bootstrapDurationMs, root: this.root }, "Guardian bootstrap complete");
    const strategyPath = path.join(this.stateDir, "strategy.json");
    const runtimePath = path.join(this.stateDir, "runtime.json");
    const obsPath = path.join(this.stateDir, "observations.json");
    try {
      await fs.access(strategyPath);
    } catch {
      const strategy = {
        version: "v0",
        weights: Object.fromEntries(this.config.topics.map(t => [t, 0.0])),
        bias: Object.fromEntries(this.config.topics.map(t => [t, 0.0]))
      };
      await writeJson(strategyPath, strategy);
    }
    try {
      await fs.access(runtimePath);
    } catch {
      const runtime = {
        state: STATE_RUNNING,
        cycle: 0,
        last_score: 0.0,
        active_version: "v0",
        snapshots: ["v0"],
        history: []
      };
      await writeJson(runtimePath, runtime);
    }
    try {
      await fs.access(obsPath);
    } catch {
      const start: Record<string, number> = {};
      for (const topic of this.config.topics) {
        if (topic === "石油价格") start[topic] = 80.0;
        else if (topic === "道琼斯指数") start[topic] = 38000.0;
        else start[topic] = 0.1;
      }
      await writeJson(obsPath, { latest: start });
    }
  }

  async run(cycles: number, sleepSeconds: number): Promise<void> {
    await this.bootstrap();
    for (let i = 0; i < cycles; i++) {
      await this.runOnce();
      if (sleepSeconds > 0) await new Promise(r => setTimeout(r, sleepSeconds * 1000));
    }
  }

  async runOnce(): Promise<void> {
    const runtimePath = path.join(this.stateDir, "runtime.json");
    const strategyPath = path.join(this.stateDir, "strategy.json");
    const obsPath = path.join(this.stateDir, "observations.json");
    const cycleStart = Date.now();
    const corrId = generateCorrelationId();
    setGlobalCorrelationId(corrId);
    const runtime = await readJson<any>(runtimePath);
    const strategy = await readJson<any>(strategyPath);
    const obs = await readJson<any>(obsPath);
    const cycle = Number(runtime.cycle) + 1;
    const latestObs = obs.latest;
    this.logger.info({ corrId, cycle, state: runtime.state, version: runtime.active_version });
    const predStart = Date.now();
    const pred = this._predict(strategy, latestObs);
    const predDurationMs = Date.now() - predStart;
    const simStart = Date.now();
    const nextObs = this._simulateMarket(latestObs);
    const simDurationMs = Date.now() - simStart;
    const score = this._scorePrediction(pred, nextObs);
    runtime.cycle = cycle;
    runtime.last_score = score;
    runtime.state = score >= this.config.degrade_threshold ? STATE_RUNNING : STATE_DEGRADED;
    if (runtime.state === STATE_DEGRADED) {
      this.logger.warn({ corrId, cycle, score, threshold: this.config.degrade_threshold });
      runtime.state = STATE_RECOVERY;
      const recoverStart = Date.now();
      await this._recover(runtime, strategy);
      const recoverDurationMs = Date.now() - recoverStart;
      this.logger.info({ corrId, cycle, recoverDurationMs, version: runtime.active_version });
    }
    let evolved = false;
    const preEvolveScore = score;
    let evolveDurationMs = 0;
    if (cycle % this.config.evolve_every === 0) {
      const evolveStart = Date.now();
      const [improved, newStrategy, newScore] = await this._evolve(strategy, latestObs, nextObs);
      evolveDurationMs = Date.now() - evolveStart;
      if (improved) {
        evolved = true;
        await writeJson(strategyPath, newStrategy);
        runtime.active_version = newStrategy.version;
        runtime.last_score = newScore;
        runtime.state = STATE_RUNNING;
        this._registerSnapshot(runtime, newStrategy.version);
        this.logger.info({ corrId, cycle, preEvolveScore, newScore, evolveDurationMs, version: newStrategy.version });
      } else {
        this.logger.debug({ corrId, cycle, newScore });
      }
    }
    runtime.history.push({
      ts: nowIso(),
      cycle,
      score: runtime.last_score,
      state: runtime.state,
      active_version: runtime.active_version
    });
    await appendJsonl(path.join(this.logsDir, "events.jsonl"), {
      ts: nowIso(),
      cycle,
      corr_id: corrId,
      obs: nextObs,
      pred,
      score: runtime.last_score,
      state: runtime.state,
      version: runtime.active_version,
      evolved,
      duration_ms: Date.now() - cycleStart
    });
    await writeJson(runtimePath, runtime);
    await writeJson(obsPath, { latest: nextObs });
    const cycleDurationMs = Date.now() - cycleStart;
    const metrics: Record<string, any> = {
      cycle,
      state: runtime.state,
      score: Number(runtime.last_score.toFixed(6)),
      version: runtime.active_version,
      duration_ms: Number(cycleDurationMs.toFixed(2)),
      pred_ms: Number(predDurationMs.toFixed(2)),
      sim_ms: Number(simDurationMs.toFixed(2)),
      evolved
    };
    if (runtime.state === STATE_RECOVERY) metrics.recovery_ms = Number((cycleDurationMs - predDurationMs - simDurationMs).toFixed(2));
    if (evolved) metrics.evolve_ms = Number(evolveDurationMs.toFixed(2));
    logMetrics(this.logger, metrics, "info");
    
    // Perform and log health check for better observability
    const health = checkEvolutionHealth(runtime.history || []);
    logHealthCheck(this.logger, health);

    this.logger.info({ corrId, cycle, state: runtime.state, score: runtime.last_score, version: runtime.active_version, duration_ms: cycleDurationMs });
  }

  _simulateMarket(last: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [topic, v] of Object.entries(last)) {
      if (topic === "石油价格") {
        const delta = Math.random() * 2.4 - 1.2;
        out[topic] = Math.max(30.0, v + delta);
      } else if (topic === "道琼斯指数") {
        const delta = Math.random() * 360 - 180;
        out[topic] = Math.max(5000.0, v + delta);
      } else {
        const delta = Math.random() * 0.04 - 0.02;
        out[topic] = Math.min(0.95, Math.max(0.01, v + delta));
      }
    }
    return out;
  }

  _predict(strategy: any, obs: Record<string, number>): Record<string, number> {
    const pred: Record<string, number> = {};
    for (const topic of this.config.topics) {
      const w = Number(strategy.weights[topic]);
      const b = Number(strategy.bias[topic]);
      if (topic === "中美战争概率") {
        const x = w * obs[topic] + b;
        pred[topic] = 1 / (1 + Math.exp(-x));
      } else {
        pred[topic] = obs[topic] + w * 0.5 + b;
      }
    }
    return pred;
  }

  _scorePrediction(pred: Record<string, number>, actual: Record<string, number>): number {
    const errors: number[] = [];
    for (const topic of this.config.topics) {
      const p = pred[topic];
      const a = actual[topic];
      const scale = topic === "道琼斯指数" ? 40000.0 : 100.0;
      const err = Math.abs(p - a) / scale;
      errors.push(err);
    }
    const mae = errors.reduce((s, v) => s + v, 0) / errors.length;
    const score = Math.max(0.0, 1.0 - mae * 5.0);
    return Number(score.toFixed(6));
  }

  async _evolve(strategy: any, latestObs: Record<string, number>, nextObs: Record<string, number>): Promise<[boolean, any, number]> {
    const basePred = this._predict(strategy, latestObs);
    const baseScore = this._scorePrediction(basePred, nextObs);
    const candidate = JSON.parse(JSON.stringify(strategy));
    for (const topic of this.config.topics) {
      candidate.weights[topic] = Number(candidate.weights[topic]) + (Math.random() * 0.6 - 0.3);
      candidate.bias[topic] = Number(candidate.bias[topic]) + (Math.random() * 0.2 - 0.1);
    }
    const candPred = this._predict(candidate, latestObs);
    const candScore = this._scorePrediction(candPred, nextObs);
    if (candScore > baseScore) {
      const oldVer = String(strategy.version);
      const newVer = this._nextVersion(oldVer);
      candidate.version = newVer;
      await writeJson(path.join(this.stateDir, `strategy_${newVer}.json`), candidate);
      this.logger.info({ evo_new_version: newVer, baseScore, candScore });
      return [true, candidate, candScore];
    }
    return [false, strategy, baseScore];
  }

  _registerSnapshot(runtime: any, version: string): void {
    const snaps: string[] = runtime.snapshots;
    if (!snaps.includes(version)) snaps.push(version);
    if (snaps.length > this.config.keep_snapshots) snaps.splice(0, snaps.length - this.config.keep_snapshots);
    runtime.snapshots = snaps;
  }

  async _recover(runtime: any, strategy: any): Promise<void> {
    const snaps: string[] = runtime.snapshots || [];
    const fallback = snaps.length ? snaps[snaps.length - 1] : "v0";
    const fallbackPath = path.join(this.stateDir, `strategy_${fallback}.json`);
    try {
      await fs.access(fallbackPath);
      const stable = await readJson<any>(fallbackPath);
      await writeJson(path.join(this.stateDir, "strategy.json"), stable);
      runtime.active_version = stable.version;
      runtime.state = STATE_RUNNING;
      this.logger.info({ recovery_version: stable.version });
    } catch {
      await writeJson(path.join(this.stateDir, "strategy.json"), strategy);
      runtime.state = STATE_RUNNING;
      this.logger.warn({ recovery_keep_current: true, fallback });
    }
  }

  _nextVersion(ver: string): string {
    if (!ver.startsWith("v")) return "v1";
    const i = Number(ver.slice(1));
    if (!Number.isFinite(i)) return "v1";
    return `v${i + 1}`;
  }
}

export async function mainPredict(args: { cycles: number; sleep: number; root: string }) {
  const g = new DaoGuardian(path.resolve(args.root));
  await g.run(args.cycles, args.sleep);
}

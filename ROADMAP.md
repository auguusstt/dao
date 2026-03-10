# DAO Evolution Roadmap (Current State of Thought)

> **Status**: Bootstrapping Automated Planning
> **Last Updated**: 2026-03-10
> **North Star**: Transform from a passive execution loop into a self-driven, goal-oriented agent.

## 1. 核心观察 (Current Observations)
- [x] 观察到 `DaoEvolver` 的 `_nextObjective` 逻辑过于机械化（轮询列表），无法根据实际失败原因动态调整。
- [x] 发现 `self_patch` 在连续失败时缺乏“跳出死循环”的元认知能力。
- [x] 实现了 `npm run sync` 功能，支持从 GitHub 同步依赖源码，提升 AI 查阅文档和代码的深度。
- [x] 建立了 `dao` 全局命令（通过 `bin/dao`），统一了进化循环的入口。
- [ ] 现有日志 (`evolution_events.jsonl`) 虽然详尽，但缺乏高层语义总结，不便于 Planner 快速理解现状。

## 2. 进化待办清单 (Backlog)
- [ ] **[High]** 实现 `Planner Agent` 模块，通过 LLM 反思最近 10 次执行记录并自动生成新目标。
- [ ] **[Medium]** 改进 `ROADMAP.md` 的自动读写机制，确保每一轮进化都有据可查。
- [ ] **[Medium]** 引入“探索模式”：Planner 定期随机读取代码片段，发现潜在的重构点（如异步模式改进）。
- [ ] **[Low]** 泛化 `dao` 命令，支持通过 `dao init` 在任意目录初始化进化环境。

## 3. 历史反思 (Retrospectives)
- **Cycle 1-166**: 
  - 经历了大量的 `无代码改动` 失败，主因是 Prompt 缺乏对“最小可验证改动”的具体指引。
  - 成功引入了 `pi-tui` 的交互界面，极大提升了人工观测体验。
  - 下一步重点应放在“规划层”的自动化上。

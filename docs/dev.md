---
title: 开发规范
tags: [dao, 开发]
category: 开发
description: 开发流程、规范
draft: false
---
# 开发规范

## 开发工作流 (Standard Workflow)

### Git Worktree 开发流程

本项目采用 **Worktree 隔离开发模式**，主分支 (main) 保持稳定，不直接修改。

**开发流程：**

1. **创建 worktree** - 开始新功能前必须执行：
   ```bash
   ./sha.sh worktree add dao-feature-<name>
   # 例：./sha.sh worktree add dao-feature-auth
   # 例：./sha.sh worktree add dao-fix-bugxxx
   ```
   这将在 `.worktree/dao-feature-<name>` 创建独立的开发环境

2. **进入 worktree 开发**：
   ```bash
   cd .worktree/dao-feature-<name>
   # 进行开发、测试、提交
   ```

3. **合并回 main** - 开发完成后必须执行：
   ```bash
   ./sha.sh worktree merge dao-feature-<name>
   ```
   此命令会自动：
  - 运行测试验证
  - 更新 main 分支
  - 合并 worktree 分支
  - 清理临时 worktree `./sha.sh worktree remove dao-feature-auth`

**常用命令：**
```bash
./sha.sh worktree list                # 查看所有 worktree 状态
```

**AI Agent 守则：**
- ⚠️ **禁止** 直接在 main 分支进行修改
- ⚠️ **禁止** 绕过 `./sha.sh worktree` 脚本创建分支
- ✅ 每次开发前必须通过 `./sha.sh worktree add` 创建隔离环境
- ✅ 合并前确保测试通过

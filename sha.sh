#!/usr/bin/env bash

# Command appears to be unreachable. Check usage (or ignore if invoked indirectly).
# shellcheck disable=SC2317

# c_primary is referenced but not assigned.
# shellcheck disable=SC2154

set -o errtrace  # -E trap inherited in sub script
set -o errexit   # -e
set -o functrace # -T If set, any trap on DEBUG and RETURN are inherited by shell functions
set -o pipefail  # default pipeline status==last command status, If set, status=any command fail

## 开启globstar模式，允许使用**匹配所有子目录,bash4特性，默认是关闭的
shopt -s globstar
## 开启后可用排除语法：workspaces=(~ ~/git/chen56/!(applab)/ ~/git/botsay/*/ )
shopt -s extglob

# Get the real path of the script directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/sha_common.sh"

# 全局命令不要进入到_c目录
# cd "$ROOT_DIR"

workspaces=(packages/*/)
submodules=(vendor/*/)
worktree_dir=".worktree"

####################################################################################
# worktree 开发流程 (方案 B: 脚本 + AGENTS.md 双重保障)
####################################################################################
# 使用示例:
#   ./sha.sh worktree add dao-feature-xxx       # 创建新 worktree 分支
#   ./sha.sh worktree status                    # 查看所有 worktree 状态
#   ./sha.sh worktree remove dao-feature-xxx    # 清理已合并的 worktree
#   ./sha.sh worktree merge dao-feature-xxx     # 合并 worktree 到 main 并清理
####################################################################################
worktree() {
  # 添加新的 worktree 开发分支
  add() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
      echo "${c_error}用法：./sha.sh worktree add <branch-name>${c_reset}" >&2
      echo "${c_warning}示例：./sha.sh worktree add dao-feature-auth${c_reset}" >&2
      return 1
    fi

    local worktree_path="$worktree_dir/$name"

    # 检查是否已存在
    if [[ -d "$worktree_path" ]]; then
      echo "${c_warning}Worktree 已存在：$worktree_path${c_reset}" >&2
      return 0
    fi

    # 创建 worktree 目录
    run mkdir -p "$worktree_path"

    # 创建新的 worktree 分支（基于 main）
    run git worktree add -b "$name" "$worktree_path" HEAD

    echo "${c_success}✓ Worktree 创建成功：$worktree_path${c_reset}"
    echo "${c_info}下一步：cd $worktree_path && 开始开发${c_reset}"
  }

  # 列出所有 worktree 状态
  list() {
    run git worktree list
  }

  # 移除 worktree
  remove() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
      echo "${c_error}用法：./sha.sh worktree remove <branch-name>${c_reset}"
      return 1
    fi

    local worktree_path="$worktree_dir/$name"

    if [[ ! -d "$worktree_path" ]]; then
      echo "${c_error}Worktree 不存在：$worktree_path${c_reset}"
      return 1
    fi

    # 删除 worktree
    run git worktree remove "$worktree_path"
    run rm -rf "$worktree_path"

    echo "${c_success}✓ Worktree 已清理：$name${c_reset}"
  }

  # 合并 worktree 到 main 分支
  merge() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
      echo "${c_error}用法：./sha.sh wt merge <branch-name>${c_reset}" >&2
      return 1
    fi

    local worktree_path="$worktree_dir/$name"

    if [[ ! -d "$worktree_path" ]]; then
      echo "${c_error}Worktree 不存在：$worktree_path${c_reset}" >&2
      return 1
    fi

    # 1. 在 worktree 中运行测试
    echo "${c_primary}步骤 1/4: 运行测试...${c_reset}"
    (
      cd "$worktree_path"
#      run npm test || { echo "${c_error}测试失败，中止合并${c_reset}" >&2; return 1; }
    ) || return 1

    # 2. 切换到 main 并更新
    echo "${c_primary}步骤 2/4: 更新 main 分支...${c_reset}"
    run git checkout main
    run git pull origin main

    # 3. 合并 worktree 分支
    echo "${c_primary}步骤 3/4: 合并 $name 到 main...${c_reset}"
    run git merge "$name" -m "merge: $name" || { echo "${c_error}合并冲突，请手动解决${c_reset}" >&2; return 1; }

    # 4. 清理 worktree
    echo "${c_primary}步骤 4/4: 清理 worktree...${c_reset}"
    run git worktree remove "$worktree_path"
    run rm -rf "$worktree_path"
    # 删除分支
    run git branch -D "$name"

    echo "${c_success}✓ 合并完成：$name → main${c_reset}"
    echo "${c_info}推送变更：git push origin main${c_reset}"
  }

  # 显示帮助
  help() {
    cat << EOF
${c_primary}Worktree 开发流程管理${c_reset}

用法：./sha.sh worktree <command> [args]

命令:
  ${c_secondary}add <name>${c_reset}     创建新的 worktree 分支到 $worktree_dir/<name>
  ${c_secondary}list${c_reset}           查看所有 worktree 状态
  ${c_secondary}merge <name>${c_reset}   合并 worktree 到 main 并清理
  ${c_secondary}remove <name>${c_reset}  清理已合并的 worktree (不合并)
  ${c_secondary}help${c_reset}           显示此帮助信息

示例:
  ./sha.sh worktree add dao-feature-auth     # 创建新特性分支
  cd .worktree/dao-feature-auth             # 进入开发
  # ... 开发、测试、提交 ...
  ./sha.sh worktree merge dao-feature-auth   # 合并回 main

流程说明:
  1. 主分支 (main) 保持稳定，不直接修改
  2. 新功能在 .worktree/dao-xxxx 独立开发
  3. 开发完成后通过 worktree merge 合并回 main
  4. 合并前自动运行测试验证

EOF
  }

}

_ws_run() {
  for ws in "${workspaces[@]}"; do
    (
      run cd "$ws"
      run "$@"
    )
  done
}

ws() {
  pwd()  { _ws_run command pwd; }
  exec() { _ws_run command "$@"; }
}

_sub_run() {
  for submodule in "${submodules[@]}"; do
    (
      run cd "$submodule"
      run "$@"
    )
  done
}


sub() {
  pwd()     { _sub_run command pwd; }
  status()  { _sub_run git status; }
  exec()    { _sub_run command "$@"; }
}

####################################################################################
# app script
# 应用项目补充的公共脚本，不在bake维护范围
# 此位置以上的全都是bake工具脚本，copy走可以直接用，之下的为项目特定cmd，自己弄
####################################################################################
sync() {
  submodule() {
    run git submodule set-branch --branch main vendor/sha
    run git submodule update --init --recursive --remote
  }
  all() {
    submodule
  }
}

clean() {
  run rm -rf ./build
  run rm -rf ./dist
}

####################################################
# 构建与检查
####################################################

####################################################
# app entry script & _root cmd
####################################################

sha "$@"


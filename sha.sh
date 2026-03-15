#!/usr/bin/env bash

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


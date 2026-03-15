#!/usr/bin/env bash
# shellcheck disable=SC2329  # 忽略函数未被使用的警告

## 开启globstar模式，允许使用**匹配所有子目录,bash4特性，默认是关闭的
shopt -s globstar

# On Mac OS, readlink -f doesn't work, so use._real_path get the real path of the file
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/" && pwd)

# _color_code: 仅提取颜色数字代码，基于 M3 Material Design 风格
_color_code() {
    local type_lower=$(echo "$1" | tr '[:upper:]' '[:lower:]')
    case "$type_lower" in
        # --- 1. M3 原子颜色 (Raw Components) ---
        # 这里的代码只包含 38; (FG) 或 48; (BG) 部分，不含重置和加粗
        "m3_primary")           echo "48;5;55"  ;;
        "m3_on_primary")        echo "38;5;255" ;;
        "m3_secondary")         echo "48;5;66"  ;;
        "m3_on_secondary")      echo "38;5;255" ;;
        "m3_tertiary")          echo "48;5;23"  ;;
        "m3_on_tertiary")       echo "38;5;255" ;;
        "m3_surface")           echo "48;5;234" ;;
        "m3_on_surface")        echo "38;5;255" ;;
        "m3_surface_container") echo "48;5;237" ;;
        "m3_surface_variant")   echo "48;5;243" ;;
        "m3_inverse_surface")   echo "48;5;255" ;;
        "m3_on_inverse_surface")echo "38;5;16"  ;;
        "m3_outline")           echo "38;5;244" ;;

        # 语义原子
        "m3_success")           echo "48;5;28"  ;;
        "m3_on_success")        echo "38;5;255" ;;
        "m3_error")             echo "48;5;124" ;;
        "m3_on_error")          echo "38;5;255" ;;
        "m3_warning")           echo "48;5;214" ;;
        "m3_on_warning")        echo "38;5;16"  ;;
        "m3_info")              echo "48;5;31"  ;;
        "m3_on_info")           echo "38;5;255" ;;

        # --- 2. 预成对的角色 (Paired Roles / Badges) ---
        # 自动组合背景+前景+加粗
        "primary")          echo "$(_color_code m3_on_primary);$(_color_code m3_primary);1" ;;
        "secondary")        echo "$(_color_code m3_on_secondary);$(_color_code m3_secondary);1" ;;
        "tertiary")         echo "$(_color_code m3_on_tertiary);$(_color_code m3_tertiary);1" ;;
        "success")          echo "$(_color_code m3_on_success);$(_color_code m3_success);1" ;;
        "error")            echo "$(_color_code m3_on_error);$(_color_code m3_error);1" ;;
        "warning")          echo "$(_color_code m3_on_warning);$(_color_code m3_warning);1" ;;
        "info")             echo "$(_color_code m3_on_info);$(_color_code m3_info);1" ;;
        "surface")          echo "$(_color_code m3_on_surface);$(_color_code m3_surface);1" ;;
        "surface_container") echo "$(_color_code m3_on_surface);$(_color_code m3_surface_container);1" ;;
        "surface_variant")  echo "$(_color_code m3_on_surface);$(_color_code m3_surface_variant);1" ;;
        "inverse_surface")  echo "$(_color_code m3_on_inverse_surface);$(_color_code m3_inverse_surface);1" ;;

        # --- 3. 纯文本角色 (Text-only Roles) ---
        "on_surface")       echo "$(_color_code m3_on_surface);1" ;;
        "outline")          echo "$(_color_code m3_outline)" ;;
        "reset")            echo "0" ;;
        *)                  echo "$(_color_code m3_outline)" ;;
    esac
}

# _color: 通用颜色包装（非 PS1）
_color() {
    local code=$(_color_code "$1")
    printf "\033[%sm" "$code"
}

# 定义全局小写常量供普通 echo/printf 使用:
c_success=$(_color success)
c_error=$(_color error)
c_warning=$(_color warning)
c_info=$(_color info)
c_primary=$(_color primary)
c_secondary=$(_color secondary)
c_tertiary=$(_color tertiary)
c_surface=$(_color surface)
c_surface_container=$(_color surface_container)
c_surface_variant=$(_color surface_variant)
c_inverse_surface=$(_color inverse_surface)
c_on_surface=$(_color on_surface)
c_outline=$(_color outline)
c_reset=$(_color reset)

# 清晰的函数调用日志，替代 `set -x` 功能
#
# Usage:   _run <some cmd>
# Example: _run docker compose up
#
# 假设你的./sake 脚本里有个函数：
# up() {
#   _run docker compose up;  # ./sake 的 22行
# }
# 运行`./sake up`后打印日志：
# 🔵 ./sake:22 up() ▶︎【/home/ubuntu/current_work_dir$ docker compose up】
# 你可以清晰的看到:
#   - 在脚本的哪一行: ./sake:22
#   - 哪个函数: up()
#   - 在哪个工作目录: /home/ubuntu/current_work_dir
#   - 执行了什么: docker compose up
# 在vscode中，按住macbook的cmd键,点终端上输出的‘./sake:106’, 可以让编辑器跳转到对应的脚本行，很方便
# 获取调用栈的原理：
#   `caller 0`输出为`22 foo ./sake`，即调用_run函数的调用栈信息：行号、函数,脚本
run() {
  local caller_script=$(caller 0 | awk '{print $3}')
    # shellcheck disable=SC2001
  local caller_script=$(echo "$caller_script" | sed "s@^$HOME@~@" )

  local caller_line=$(caller 0 | awk '{print $1}')
  # 把 /home/ubuntu/current_work_dir 替换为 ~/current_work_dir 短格式
  # 使用 @ 作为分隔符，避免与路径中的 / 冲突
  # shellcheck disable=SC2001
  local current_pwd=$(echo "$PWD" | sed "s@^$HOME@~@" )
  local color_caller="${c_secondary}${caller_script}:${caller_line} ${FUNCNAME[1]}() ${c_reset}"
  local color_pwd="${c_info}${current_pwd} ${c_reset}"
  local color_cmd="${c_primary}$*${c_reset}"
  echo "$color_caller$color_pwd$color_cmd" >&2
  "$@"
}

# run pwd
# shellcheck source=../vendor/sha.bash
run git submodule update
source "$ROOT_DIR/vendor/sha/sha.bash"
shopt -s expand_aliases  # bash默认不开启alias 扩展

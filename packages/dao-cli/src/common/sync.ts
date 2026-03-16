import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import * as jsonc from "jsonc-parser";
import { logger } from "./logger.js";

const log = logger.withTag("sync");

const GLOBAL_CACHE_DIR = path.join(os.homedir(), ".dao");
const METADATA_CACHE_PATH = path.join(GLOBAL_CACHE_DIR, "registry-cache.json");

/**
 * 清理 execSync 输出中的杂讯 (如 Agent pid, shell loading messages)
 */
function cleanExecOutput(output: string): string {
  return output
    .split("\n")
    .filter(line => {
      const l = line.trim();
      if (!l) return false;
      if (l.startsWith("Agent pid")) return false;
      if (l.includes("load ~/.bashrc")) return false;
      return !l.includes("Output: load");

    })
    .join("\n")
    .trim();
}

/**
 * 工作区包信息
 */
interface WorkspaceInfo {
  name: string;
  version: string;
  path: string;
  relativePath: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/**
 * 获取所有工作区包信息
 */
function getWorkspacePackages(): Map<string, WorkspaceInfo> {
  const workspaceMap = new Map<string, WorkspaceInfo>();
  try {
    const rootPkgPath = path.resolve(process.cwd(), "package.json");
    if (fs.existsSync(rootPkgPath)) {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
      // 添加根包
      workspaceMap.set(rootPkg.name || "root", {
        name: rootPkg.name || "root",
        version: rootPkg.version || "0.0.0",
        path: process.cwd(),
        relativePath: ".",
        dependencies: rootPkg.dependencies || {},
        devDependencies: rootPkg.devDependencies || {},
      });

      const workspaces = rootPkg.workspaces;
      if (Array.isArray(workspaces)) {
        for (const pattern of workspaces) {
          const baseDir = pattern.replace(/\/\*$/, "");
          const fullBaseDir = path.resolve(process.cwd(), baseDir);
          if (fs.existsSync(fullBaseDir)) {
            const dirs = fs.readdirSync(fullBaseDir);
            for (const dir of dirs) {
              const pkgDir = path.join(fullBaseDir, dir);
              const pkgPath = path.join(pkgDir, "package.json");
              if (fs.existsSync(pkgPath)) {
                try {
                  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
                  if (pkg.name) {
                    workspaceMap.set(pkg.name, {
                      name: pkg.name,
                      version: pkg.version || "0.0.0",
                      path: pkgDir,
                      relativePath: path.relative(process.cwd(), pkgDir),
                      dependencies: pkg.dependencies || {},
                      devDependencies: pkg.devDependencies || {},
                    });
                  }
                } catch ( _e) { /* ignore */ }
              }
            }
          }
        }
      }
    }
  } catch ( _e) { /* ignore */ }
  return workspaceMap;
}

/**
 * 元数据项
 */
interface MetadataItem {
  repoUrl: string;
  subDir: string;
  lastVersion: string;
}

/**
 * 元数据缓存
 */
let metadataCache: Record<string, MetadataItem> = {};
try {
  if (fs.existsSync(METADATA_CACHE_PATH)) {
    metadataCache = JSON.parse(fs.readFileSync(METADATA_CACHE_PATH, "utf-8"));
  }
} catch ( _e) {
  // 忽略缓存读取错误
}

function saveMetadataCache(): void {
  if (!fs.existsSync(GLOBAL_CACHE_DIR)) fs.mkdirSync(GLOBAL_CACHE_DIR, { recursive: true });
  fs.writeFileSync(METADATA_CACHE_PATH, JSON.stringify(metadataCache, null, 2));
}

/**
 * 仓库信息
 */
interface RepoInfo {
  host: string;
  owner: string;
  repo: string;
}

/**
 * 解析 Git URL
 */
function parseRepoUrl(url: string): RepoInfo | null {
  let cleanUrl = url.trim();
  // 移除 git+ 前缀和 .git 后缀
  if (cleanUrl.startsWith("git+")) cleanUrl = cleanUrl.slice(4);
  if (cleanUrl.endsWith(".git")) cleanUrl = cleanUrl.slice(0, -4);

  // 处理 git@ 格式
  if (cleanUrl.startsWith("git@")) {
    const match = cleanUrl.match(/^git@([^:]+):([^/]+)\/(.+)$/);
    if (match) return { host: match[1] as string, owner: match[2] as string, repo: match[3] as string };
  }

  // 处理各种协议 (http, https, git)
  try {
    // 统一替换 git:// 为 https:// 以便 URL 解析，或者直接处理已有的 http/https
    const urlWithProtocol = cleanUrl.replace(/^git:\/\//, "https://");
    const urlObj = new URL(urlWithProtocol.includes("://") ? urlWithProtocol : `https://${urlWithProtocol}`);

    const host = urlObj.host;
    const parts = urlObj.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return { host, owner: parts[0] as string, repo: parts[1] as string };
  } catch ( _e) {
    // 忽略解析错误
  }
  return null;
}

/**
 * 获取最佳 Tag
 */
function getBestTag(repoUrl: string, version: string): string | null {
  try {
    const cloneUrl = repoUrl.startsWith("http") ? repoUrl : `https://${repoUrl}`;
    log.info(`[Git] 正在获取远端 Tag 信息: ${cloneUrl}`);
    const tagsOutput = cleanExecOutput(execSync(`git ls-remote --tags ${cloneUrl}`, { stdio: "pipe" }).toString());
    const tags = tagsOutput
      .split("\n")
      .filter(line => line.includes("refs/tags/"))
      .map(line => line.split("refs/tags/")[1]?.replace(/\^{}$/, "") ?? "")
      .filter(Boolean);
    const candidates = [`v${version}`, version];
    for (const cand of candidates) {
      if (tags.includes(cand)) return cand;
    }
  } catch ( _e) {
    // 忽略 git ls-remote 错误
  }
  return null;
}

/**
 * 项目配置
 */
interface ProjectConfig {
  overrides?: Record<string, { tag?: string; repoUrl?: string; subDir?: string }>;
}

/**
 * 同步结果
 */
interface SyncResult {
  relativePath: string;
  absolutePath: string;
}

async function processPackage(
  name: string,
  version: string,
  globalRefBase: string,
  projectRefBase: string,
  config?: ProjectConfig,
  workspacePackages?: Map<string, WorkspaceInfo>
): Promise<SyncResult | null> {
  try {
    // 跳过本地 workspace 依赖
    if (version.startsWith("workspace:") || workspacePackages?.has(name)) {
      log.debug(`[${name}] 跳过本地 Workspace 依赖`);
      return null;
    }

    const override = config?.overrides?.[name];

    // 1. 获取仓库元数据 (优先从缓存读取)
    let repoUrl = "";
    let subDir = "";
    if (override?.repoUrl) {
        repoUrl = override.repoUrl;
        subDir = override.subDir || "";
        log.debug(`[${name}] 使用配置覆盖的元数据: ${repoUrl}`);
    } else if (metadataCache[name] && (metadataCache[name].lastVersion === version || metadataCache[name].lastVersion.includes(version))) {
        repoUrl = metadataCache[name].repoUrl;
        subDir = metadataCache[name].subDir;
        log.debug(`[${name}] 使用缓存的元数据: ${repoUrl}`);
    } else {
        log.info(`[${name}] 正在从 npm registry 获取元数据...`);
        try {
          repoUrl = cleanExecOutput(execSync(`npm view ${name} repository.url`, { stdio: "pipe" }).toString());
          try {
              subDir = cleanExecOutput(execSync(`npm view ${name} repository.directory`, { stdio: "pipe" }).toString());
          } catch( _e) {
              // 忽略 directory 不存在的错误
          }
        } catch (err: any) {
          log.warn(`[${name}] 无法获取 npm 元数据, 请检查网络或是否为私有包: ${err.message}`);
          return null;
        }
        metadataCache[name] = { repoUrl, subDir, lastVersion: version };
        log.debug(`[${name}] 从远程获取元数据: ${repoUrl}`);
    }

    const repoInfo = parseRepoUrl(repoUrl);
    if (!repoInfo) {
      log.warn(`[${name}] 无法解析仓库地址: ${repoUrl}`);
      return null;
    }

    const cloneUrl = `https://${repoInfo.host}/${repoInfo.owner}/${repoInfo.repo}`;

    // 2. 检查本地是否已下载
    const versionDirNameBase = version.replace(/^[\^~]/, "");
    const possibleNames = override?.tag ? [override.tag] : [versionDirNameBase, `v${versionDirNameBase}`];

    let finalGlobalPath = "";
    for (const pName of possibleNames) {
        const p = path.join(globalRefBase, repoInfo.host, repoInfo.owner, repoInfo.repo, pName);
        if (fs.existsSync(p)) {
            finalGlobalPath = p;
            log.debug(`[${name}] 命中本地版本缓存: ${p}`);
            break;
        }
    }

    if (!finalGlobalPath) {
        log.info(`正在同步新源码: ${name}@${version}${override?.tag ? ` (Override Tag: ${override.tag})` : ""}`);

        let bestTag: string | null = null;
        if (override?.tag) {
            bestTag = override.tag;
        } else {
            bestTag = getBestTag(cloneUrl, versionDirNameBase);
        }

        // 优先使用 bestTag 作为目录名，如果没有则用版本号
        const finalDirName = bestTag || versionDirNameBase;
        finalGlobalPath = path.join(globalRefBase, repoInfo.host, repoInfo.owner, repoInfo.repo, finalDirName);

        if (!fs.existsSync(finalGlobalPath)) {
            const branchCmd = bestTag ? `--branch ${bestTag}` : "";
            const cloneCmd = `git clone --depth 1 ${branchCmd} ${cloneUrl} "${finalGlobalPath}"`;
            log.info(`[${name}] 执行克隆: ${cloneCmd}`);
            fs.mkdirSync(path.dirname(finalGlobalPath), { recursive: true });
            try {
              execSync(cloneCmd, { stdio: ["ignore", "pipe", "pipe"] });
            } catch (err: any) {
              const stderr = err.stderr?.toString().trim() || err.message;
              throw new Error(`Git clone 失败: ${stderr}`);
            }
        }
    }

    // 4. 创建软连接 (结构同全局缓存: host/owner/repo/version)
    const versionDirName = path.basename(finalGlobalPath);
    const projectRepoLink = path.join(projectRefBase, repoInfo.host, repoInfo.owner, repoInfo.repo, versionDirName);
    const relativeRepoPath = `./.dao/ref/${repoInfo.host}/${repoInfo.owner}/${repoInfo.repo}/${versionDirName}`;

    try {
      fs.rmSync(projectRepoLink, { recursive: true, force: true });
    } catch ( _e) {
        // 忽略删除失败
    }

    const linkParent = path.dirname(projectRepoLink);
    if (!fs.existsSync(linkParent)) fs.mkdirSync(linkParent, { recursive: true });

    const relativeTarget = path.relative(linkParent, finalGlobalPath);
    fs.symlinkSync(relativeTarget, projectRepoLink, "dir");

    log.debug(`[${name}] 软连接建立成功: ${name} -> ${relativeRepoPath}`);
    return {
        relativePath: subDir ? `${relativeRepoPath}/${subDir}` : relativeRepoPath,
        absolutePath: subDir ? path.join(finalGlobalPath, subDir) : finalGlobalPath
    };
  } catch (err: unknown) {
    log.error(`[${name}] 同步失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 更新 AGENTS.md 中的依赖列表
 */
function updateAgentsMdWithDeps(workspacePackages: Map<string, WorkspaceInfo>, syncResults: Record<string, SyncResult> = {}): void {
  const agentsMdPath = path.resolve(process.cwd(), "AGENTS.md");
  if (!fs.existsSync(agentsMdPath)) return;

  const log = logger.withTag("Agents");
  try {
    let content = fs.readFileSync(agentsMdPath, "utf-8");
    const sectionHeader = "## 直接依赖 (Dependencies)";
    const startTag = "<!-- DAO_DEPS_START -->";
    const endTag = "<!-- DAO_DEPS_END -->";
    const warning = "<!-- 自动生成，请勿手动修改 (Auto-generated, do not edit manually) -->";
    const formatNote = "<!-- 依赖树格式说明: 格式为 `[包名@版本] -> [源代码目录]` , 第一层为本项目 Workspace 模块；缩进层为该模块的直接依赖；`->` 后缀指向该依赖的本地源代码映射路径，供 AI 精准分析源码。 -->";

    const depLines: string[] = [];

    // 对 workspacePackages 进行排序，使根目录排在前面，然后按名称字母排序
    const sortedWorkspacePackages = Array.from(workspacePackages.values()).sort((a, b) => {
      if (a.relativePath === "." && b.relativePath !== ".") return -1;
      if (a.relativePath !== "." && b.relativePath === ".") return 1;
      return a.name.localeCompare(b.name);
    });

    for (const pkgInfo of sortedWorkspacePackages) {
      depLines.push(`- ${pkgInfo.name}@${pkgInfo.version || "unknown"} -> ${pkgInfo.relativePath}`);

      const combinedDeps = { ...pkgInfo.dependencies, ...pkgInfo.devDependencies };
      // 按照依赖名称排序
      const sortedDeps = Object.entries(combinedDeps).sort(([nameA], [nameB]) => nameA.localeCompare(nameB));

      for (const [depName, depVersion] of sortedDeps) {
        const res = syncResults[depName];
        let depLine = `  - ${depName}@${depVersion}`;
        if (res) {
          const cleanPath = res.relativePath.startsWith("./") ? res.relativePath.slice(2) : res.relativePath;
          depLine += ` -> ${cleanPath}`;
        }
        depLines.push(depLine);
      }
    }

    const depList = depLines.join("\n");

    const newChunk = `${startTag}\n${warning}\n${formatNote}\n${depList}\n${endTag}`;

    const startIndex = content.indexOf(startTag);
    const endIndex = content.indexOf(endTag);

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      // 模式 A: 已存在标签，直接替换中间内容
      content = content.slice(0, startIndex) + newChunk + content.slice(endIndex + endTag.length);
    } else {
      // 模式 B: 尚无标签，寻找标题
      const lines = content.split("\n");
      const sectionIndex = lines.findIndex(line => line.trim() === sectionHeader);

      if (sectionIndex !== -1) {
        // 找到标题，在标题下方插入内容（保留标题后的空行逻辑）
        let nextContentIndex = sectionIndex + 1;
        // 如果标题后紧跟了空行，跳过它
        if (lines[nextContentIndex]?.trim() === "") nextContentIndex++;

        lines.splice(nextContentIndex, 0, "\n" + newChunk + "\n");
        content = lines.join("\n");
      } else {
        // 没找到标题，追加到末尾
        content = content.trim() + "\n\n" + sectionHeader + "\n\n" + newChunk + "\n";
      }
    }

    fs.writeFileSync(agentsMdPath, content.trim() + "\n");
    log.info("AGENTS.md 依赖列表已更新 (使用结构化锚点)");
  } catch (err) {
    log.warn(`更新 AGENTS.md 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 根 Package 对象接口
 */
interface PackageJson {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

export async function syncDependencies(): Promise<void> {
  log.info(`sync start`);

  const pkgPath = path.resolve(process.cwd(), "package.json");
  const tsConfigPath = path.resolve(process.cwd(), "tsconfig.ide.json");
  const projectConfigPath = path.resolve(process.cwd(), ".dao", "config.json");

  if (!fs.existsSync(pkgPath)) {
    log.error("未找到 package.json");
    return;
  }

  // 加载项目配置
  let projectConfig: ProjectConfig = {};
  if (fs.existsSync(projectConfigPath)) {
    try {
      projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, "utf-8"));
    } catch ( _e) {
      log.warn(`无法解析项目配置: ${projectConfigPath}`);
    }
  }

  const pkg: PackageJson = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

  // 汇总所有依赖：包括根目录和所有工作区子包的 dependencies + devDependencies
  const workspacePackages = getWorkspacePackages();
  const allDeps: Record<string, string> = {
    ...(pkg.dependencies || {}),
    ...((pkg as any).devDependencies || {})
  };

  for (const pkgInfo of workspacePackages.values()) {
    Object.assign(allDeps, pkgInfo.dependencies, pkgInfo.devDependencies);
  }

  const globalRefBase = path.join(GLOBAL_CACHE_DIR, "ref");
  const projectRefBase = path.resolve(process.cwd(), ".dao", "ref");

  log.info(`开始同步 ${Object.keys(allDeps).length} 个依赖 (含所有子包 devDeps)...`);
  const startTime = Date.now();
  const syncResults: Record<string, SyncResult> = {};
  const entries = Object.entries(allDeps);

  // 顺序处理每个包
  for (let i = 0; i < entries.length; i++) {
    const [name, version] = entries[i];
    log.info(`[${i + 1}/${entries.length}] 正在处理 ${name}@${version}...`);
    const result = await processPackage(name, version as string, globalRefBase, projectRefBase, projectConfig, workspacePackages);
    if (result) syncResults[name] = result;
  }

  saveMetadataCache();

  // 更新 AGENTS.md 中的依赖列表
  updateAgentsMdWithDeps(workspacePackages, syncResults);

  // 更新 tsconfig.ide.json
  if (fs.existsSync(tsConfigPath)) {
    const configLog = logger.withTag("Config");
    configLog.info("正在更新 tsconfig.ide.json paths...");
    let content = fs.readFileSync(tsConfigPath, "utf-8");
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

    const parsedTsConfig = jsonc.parse(content);
    const currentPaths = parsedTsConfig?.compilerOptions?.paths || {};
    const newPaths: Record<string, string[]> = {};

    // 1. 保留现有的本地 workspace 映射
    for (const [key, val] of Object.entries(currentPaths)) {
      const baseName = key.endsWith("/*") ? key.slice(0, -2) : key;
      if (workspacePackages.has(baseName)) {
        newPaths[key] = val as string[];
      }
    }

    // 2. 添加新同步成功的映射
    for (const [name, version] of Object.entries(allDeps)) {
      const paths = syncResults[name];
      if (!paths) {
        if ((version as string).startsWith("workspace:") && !newPaths[name]) {
          configLog.debug(`[${name}] 本地 Workspace 包尚未建立映射，请手动配置或检查包名`);
        }
        continue;
      }

      const { relativePath, absolutePath } = paths;
      let entry = "";
      // 优先尝试映射到编译后的目录，减少 TS 扫描源码的压力
      const candidates = ["dist/index.js", "build/index.js", "dist/index.d.ts", "src/index.ts", "src/tui.ts", "index.ts"];
      for (const cand of candidates) {
        if (fs.existsSync(path.join(absolutePath, cand))) {
          // 如果找到的是 .js 或 .d.ts，我们映射到其目录或不带后缀的路径，让 TS 自己解析 package.json
          if (cand.endsWith(".js") || cand.endsWith(".d.ts")) {
            entry = ""; // 映射到根目录，靠 package.json 导航
          } else {
            entry = cand;
          }
          break;
        }
      }
      const tsPath = entry ? `${relativePath}/${entry}` : relativePath;
      newPaths[name] = [tsPath];
      newPaths[`${name}/*`] = [`${relativePath}/${entry ? path.dirname(entry) + "/*" : "*"}`];
      configLog.debug(`映射: ${name} -> ${tsPath}`);
    }

    let edits = jsonc.modify(content, ["compilerOptions", "baseUrl"], ".", options);
    content = jsonc.applyEdits(content, edits);
    edits = jsonc.modify(content, ["compilerOptions", "paths"], newPaths, options);
    content = jsonc.applyEdits(content, edits);

    fs.writeFileSync(tsConfigPath, content);
    configLog.info("tsconfig.ide.json 更新成功！");
  }

  // 5. 处理 Agent 配置文件软链接 (让多 Agent 共享 AGENTS.md)
  const agentsMd = path.resolve(process.cwd(), "AGENTS.md");
  if (fs.existsSync(agentsMd)) {
    const agentFiles = ["GEMINI.md", "QWEN.md"];
    const agentLog = logger.withTag("Agents");
    for (const agentFile of agentFiles) {
      const agentPath = path.resolve(process.cwd(), agentFile);
      try {
        let shouldCreate = true;
        if (fs.existsSync(agentPath)) {
          const stats = fs.lstatSync(agentPath);
          if (stats.isSymbolicLink()) {
            const target = fs.readlinkSync(agentPath);
            if (target === "AGENTS.md") {
              shouldCreate = false; // 已存在正确的链接
            } else {
              fs.unlinkSync(agentPath); // 错误的链接，删除
            }
          } else {
            // 普通文件，备份并删除
            const backupPath = `${agentPath}.bak`;
            if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
            fs.renameSync(agentPath, backupPath);
            agentLog.info(`备份已有文件: ${agentFile} -> ${agentFile}.bak`);
          }
        }

        if (shouldCreate) {
          // 使用相对路径进行链接，提高可移植性
          fs.symlinkSync("AGENTS.md", agentPath);
          agentLog.info(`强制同步软链接: ${agentFile} -> AGENTS.md`);
        }
      } catch ( _e) {
        agentLog.warn(`无法为 ${agentFile} 处理软链接: ${_e instanceof Error ? _e.message : String(_e)}`);
      }
    }
  }

  log.success(`同步完成！耗时: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
}

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
    const tagsOutput = execSync(`git ls-remote --tags ${cloneUrl}`, { stdio: "pipe" }).toString();
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
  config?: ProjectConfig
): Promise<SyncResult | null> {
  try {
    // 跳过本地 workspace 依赖
    if (version.startsWith("workspace:")) {
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
        repoUrl = execSync(`npm view ${name} repository.url`, { stdio: "pipe" }).toString().trim();
        try {
            subDir = execSync(`npm view ${name} repository.directory`, { stdio: "pipe" }).toString().trim();
        } catch( _e) {
            // 忽略 directory 不存在的错误
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
            execSync(cloneCmd, { stdio: "inherit" });
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
 * 根 Package 对象接口
 */
interface PackageJson {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

export async function syncDependencies(): Promise<void> {
  log.info(`sync start`);

  const pkgPath = path.resolve(process.cwd(), "package.json");
  const tsConfigPath = path.resolve(process.cwd(), "tsconfig.json");
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
  const allDeps = { ...(pkg.dependencies || {}), ...((pkg as any).devDependencies || {}) };
  const globalRefBase = path.join(GLOBAL_CACHE_DIR, "ref");
  const projectRefBase = path.resolve(process.cwd(), ".dao", "ref");

  log.info(`开始同步 ${Object.keys(allDeps).length} 个依赖...`);
  const startTime = Date.now();
  const syncResults: Record<string, SyncResult> = {};

  // 顺序处理每个包
  for (const [name, version] of Object.entries(allDeps)) {
    const result = await processPackage(name, version as string, globalRefBase, projectRefBase, projectConfig);
    if (result) syncResults[name] = result;
  }

  saveMetadataCache();

  // 更新 tsconfig.json
  if (fs.existsSync(tsConfigPath)) {
    const configLog = logger.withTag("Config");
    configLog.info("正在更新 tsconfig.json paths...");
    let content = fs.readFileSync(tsConfigPath, "utf-8");
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    
    const parsedTsConfig = jsonc.parse(content);
    const currentPaths = parsedTsConfig?.compilerOptions?.paths || {};
    const newPaths = { ...currentPaths };

    for (const [name, version] of Object.entries(allDeps)) {
      if ((version as string).startsWith("workspace:")) {
        // 如果是本地 workspace 包，且已经有 paths 映射，则保留它，不要覆盖
        if (newPaths[name]) {
          configLog.debug(`[${name}] 保留现有的本地 Workspace 映射`);
          continue;
        }
      }

      const paths = syncResults[name];
      if (!paths) continue;

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
    configLog.info("tsconfig.json 更新成功！");
  }

  log.success(`同步完成！耗时: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
}

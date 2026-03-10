import { promises as fs } from "fs";
import path from "path";
import { parse } from "jsonc-parser";

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  const text = await fs.readFile(p, "utf-8");
  const data = parse(text);
  if (data === undefined) {
    throw new Error(`Failed to parse JSON from ${p}`);
  }
  return data as T;
}

export async function writeJson(p: string, obj: unknown): Promise<void> {
  const text = JSON.stringify(obj, null, 2);
  const dir = path.dirname(p);
  await ensureDir(dir);
  const tmp = path.join(dir, `.tmp.${path.basename(p)}.${Math.random().toString(36).slice(2)}`);
  try {
    await fs.writeFile(tmp, text, "utf-8");
    await fs.rename(tmp, p);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export async function appendJsonl(p: string, obj: unknown): Promise<void> {
  const line = JSON.stringify(obj) + "\n";
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, line, "utf-8");
}

export async function backupFile(p: string): Promise<string | null> {
  try {
    await fs.access(p);
    const ext = path.extname(p);
    const base = path.basename(p, ext);
    const dir = path.dirname(p);
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(dir, `${base}.${time}.bak${ext}`);
    await fs.copyFile(p, backup);
    return backup;
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

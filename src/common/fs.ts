import { promises as fs } from "fs";
import path from "path";
import { parse } from "jsonc-parser";

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function readJson<T = any>(p: string): Promise<T> {
  const text = await fs.readFile(p, "utf-8");
  const data = parse(text);
  return data as T;
}

export async function writeJson(p: string, obj: any): Promise<void> {
  const text = JSON.stringify(obj, null, 2);
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, text, "utf-8");
}

export async function appendJsonl(p: string, obj: any): Promise<void> {
  const line = JSON.stringify(obj) + "\n";
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, line, "utf-8");
}

export function nowIso(): string {
  return new Date().toISOString();
}

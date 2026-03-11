declare module "path";
declare module "fs";
declare module "child_process" {
  import { ChildProcess as CP } from "node:child_process";
  export const spawn: typeof import("node:child_process").spawn;
  export const spawnSync: typeof import("node:child_process").spawnSync;
  export type ChildProcess = CP;
}
declare module "jsonc-parser";
declare module "commander";
declare module "os";
declare const process: any;

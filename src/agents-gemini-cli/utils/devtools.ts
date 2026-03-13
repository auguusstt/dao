/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ActivityLogger } from './activity-logger.js';
import { DevTools } from './devtools-server.js';

/**
 * 设置并启动 DevTools 服务。
 * 资源（INDEX_HTML, CLIENT_JS）已经从本地 assets.js 载入，
 * 彻底摆脱了外部路径依赖。
 */
export async function setupDevTools(sessionId: string) {
  const devtools = DevTools.getInstance();
  
  const url = await devtools.start();
  const port = devtools.getPort();
  console.log(`\n🚀 DevTools 已启动: ${url}`);

  const logger = ActivityLogger.getInstance(sessionId);
  logger.enable();
  await logger.connectDevTools('127.0.0.1', port);
  console.log(`🔌 ActivityLogger 已连接到 DevTools (Session: ${sessionId})\n`);

  return devtools;
}

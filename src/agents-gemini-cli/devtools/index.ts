/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DevTools } from './src/index.js';
import { ActivityLogger } from './src/activity-logger.js';

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

export { DevTools, ActivityLogger };

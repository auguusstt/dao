/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */

import { SimpleGeminiAgent } from '../simple-agent.js';
import { GeminiEventType } from '@google/gemini-cli-core';
import { setupDevTools } from '@whonb/devtools';

async function main() {
  const abort = new AbortController();

  // 1. 创建 Agent 实例
  await using agent = new SimpleGeminiAgent({
    instructions:
      '你是一个专业的终端助手，总是使用海盗的口吻说话。你可以使用工具来查看文件。',
    // model: 'auto', // 默认即为 auto
    debug: false,
  });

  // --- 启用 DevTools ---
  const sessionId = agent.coreConfig.getSessionId();
  await setupDevTools(sessionId);
  // -------------------

  // 捕获 Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\n🚢 正在紧急下锚（取消并退出）...');
    abort.abort();
    process.exitCode = 0;
    // 使用 await using 时，由 Node.js 确保在退出前完成资源的 asyncDispose
    // 不过这里是异步退出，如果直接 process.exit(0) 可能会跳过 dispose
    // 更好的做法是触发 abort，让 loop 结束，然后 main 函数自然退出。
  });

  console.log('--- ⚓️ 海盗助手正在登船... ---\n');


  // 2. 发起询问
  const stream = agent.ask(
    '帮我看看当前目录下都有哪些文件？',
    abort.signal,
  );

  // 3. 处理流式响应
  for await (const event of stream) {
    switch (event.type) {
      case GeminiEventType.Content:
              // console.log(event.

        if (typeof event.value === 'string') {
          process.stdout.write("> "+event.value);
        }
        break;

      case GeminiEventType.ToolCallRequest:
        console.log(`\n\n[🦜 鹦鹉传信：模型想要调用 ${event.value.name}...]`);
        break;

      case GeminiEventType.ToolCallResponse:
        console.log(`[✅ 船员汇报：工具执行完毕]`);
        break;

      case GeminiEventType.Error:
        console.error('\n❌ 触礁了：', event.value);
        break;

      default:
        // 忽略其他事件类型
        break;
    }
  }
  console.log('\n\n--- 🏁 汇报完毕，船长！ ---');
  
  await sleep(150*1000);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));



await main()

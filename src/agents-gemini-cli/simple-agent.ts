/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import {
  Config,
  AuthType,
  getAuthTypeFromEnv,
  GeminiEventType,
  scheduleAgentTools,
  type ServerGeminiStreamEvent,
  PolicyDecision,
  type Part,
  type ToolCallRequestInfo,
} from '@google/gemini-cli-core';

export interface SimpleAgentOptions {
  instructions: string;
  model?: string;
  cwd?: string;
  debug?: boolean;
}

/**
 * 一个对 core 包的精简包装。
 * 学习了原 SDK 的配置方式，确保在 OAuth 环境下依然稳健。
 */
export class SimpleGeminiAgent {
  private readonly config: Config;
  private initialized = false;

  constructor(options: SimpleAgentOptions) {
    const cwd = options.cwd || process.cwd();

    // 关键：模仿原 SDK 的配置，不传递 modelConfigServiceConfig，让 core 使用默认逻辑
    this.config = new Config({
      sessionId: `simple-${Math.random().toString(36).slice(2, 10)}`,
      targetDir: cwd,
      cwd,
      model: options.model || 'auto', // 改为 auto 触发路由
      userMemory: options.instructions,
      debugMode: options.debug ?? false,
      // 以下是原 SDK 的标准配置
      enableHooks: false,
      mcpEnabled: false,
      extensionsEnabled: false,
      policyEngineConfig: {
        defaultDecision: PolicyDecision.ALLOW,
      },
    });
  }

  /**
   * 初始化环境。
   */
  async initialize() {
    if (this.initialized) return;

    // 1. 完全遵循原 SDK 的鉴权识别逻辑
    const authType = getAuthTypeFromEnv() || AuthType.COMPUTE_ADC;

    // 2. 刷新鉴权并初始化（原 SDK 并没有在这里 catch Error）
    await this.config.refreshAuth(authType);
    await this.config.initialize();

    // 3. 初始化核心客户端
    const client = this.config.geminiClient;
    await client.initialize();

    this.initialized = true;
  }

  /**
   * 发送消息。
   */
  async *ask(
    prompt: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ServerGeminiStreamEvent> {
    if (!this.initialized) await this.initialize();

    const client = this.config.getGeminiClient();
    const sessionId = this.config.getSessionId();
    let currentRequestParts: Part[] = [{ text: prompt }];

    while (true) {
      if (signal?.aborted) break;

      const stream = client.sendMessageStream(
        currentRequestParts,
        signal ?? new AbortController().signal,
        sessionId,
      );
      const toolCalls: ToolCallRequestInfo[] = [];

      for await (const event of stream) {
        yield event;
        if (event.type === GeminiEventType.ToolCallRequest) {
          toolCalls.push(event.value as any);
        }
      }

      if (toolCalls.length === 0 || signal?.aborted) break;

      const completedCalls = await scheduleAgentTools(this.config, toolCalls, {
        schedulerId: sessionId,
        toolRegistry: this.config.getToolRegistry(),
        signal: signal ?? new AbortController().signal,
      });

      currentRequestParts = completedCalls.flatMap(
        (call) => call.response.responseParts,
      ) as any;
    }
  }

  private isDisposed = false;
  async dispose(): Promise<void> {
    // 防止重复调用 dispose
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    await this.config.dispose();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  get coreConfig() {
    return this.config;
  }
}

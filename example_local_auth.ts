import { Config, GeminiClient, AuthType, createSessionId } from '@google/gemini-cli-core';

async function main() {
  const sessionId = createSessionId();
  const cwd = process.cwd();

  // 1. 初始化 Config，使用 COMPUTE_ADC 进行本地授权
  // 提示：如果您使用的是 Vertex AI，建议设置环境变量 GOOGLE_CLOUD_PROJECT 和 GOOGLE_CLOUD_LOCATION
  const config = new Config({
    sessionId,
    targetDir: cwd,
    cwd,
    debugMode: false, // 关闭调试模式以减少日志干扰
    model: 'auto-gemini-2.5', // 使用 CLI 推荐的 Auto 模式
        // 其他必要的基础配置
    mcpEnabled: false,
    extensionsEnabled: false,
    skillsSupport: false,

  });

  console.log("正在刷新授权 (使用 ADC)...");
  try {
    // 刷新授权。如果本地已运行 gcloud auth application-default login，此步骤将使用该凭据。
    await config.refreshAuth(AuthType.COMPUTE_ADC);
    await config.initialize();
  } catch (error) {
    console.error("授权失败，请确保已运行 'gcloud auth application-default login'。");
    throw error;
  }

  // 2. 初始化 GeminiClient
  const client = config.getGeminiClient();
  await client.initialize();

  // 3. 发送消息并获取流式回复
  console.log("正在查询 Gemini...");
  const prompt = "请用一个词解释什么是 DAO？";
  const controller = new AbortController();
  
  // sendMessageStream 返回 AsyncGenerator<ServerGeminiStreamEvent, Turn>
  const stream = client.sendMessageStream([{ text: prompt }], controller.signal, sessionId);

  process.stdout.write("Gemini 回复: ");
  for await (const event of stream) {
    if (event.type === 'chunk' && event.value.candidates?.[0]?.content?.parts) {
      const text = event.value.candidates[0].content.parts[0].text;
      if (text) process.stdout.write(text);
    }
  }
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error("运行出错:", err);
  process.exit(1);
});

# DAO TS 自主进化循环

此目录包含 TypeScript 版的守护与进化循环实现，用于在独立子仓中进行“最小可验证改动”的开发与验证。

## 参考

- [geminicli](https://geminicli.com)为例:
- [context7](https://context7.com/websites/geminicli)
- [deepwiki](https://deepwiki.com/google-gemini/gemini-cli)

### code agent cli

- cli
  - agent cli真正免费能打的就这几个：
    - geminicli 
    - codebuddy
    - qwen-code
  - 试用：
    - codex: 额度少
- 其他
  - [v0 by Vercel](https://v0.app)  


### tui lib

- [ink](https://github.com/vadimdemedes/ink)
- [opentui](https://github.com/anomalyco/opentui)
- [pi-tui](https://github.com/badlogic/pi-mono/tree/main/packages/tui)
- <https://github.com/RtlZeroMemory/Rezi>
  - c语言引擎，漂亮

### gen ui / agent ui


- **重要参考**
- [json-render](https://github.com/vercel-labs/json-render)  
- [Vercel AI SDK](https://vercel.com/docs/ai-sdk)  
- [CopilotKit](https://github.com/CopilotKit/CopilotKit)  
  - copilotkit generative-ui
    - <https://docs.copilotkit.ai/generative-ui>
    - <https://github.com/CopilotKit/generative-ui>
- [A2UI](https://github.com/google/A2UI)  
  - a2ui builder  <https://a2ui-composer.ag-ui.com/>  
- [LangChain Agent Chat UI](https://github.com/langchain-ai/agent-chat-ui)  


- **其他**
  - [Assistant UI](https://github.com/assistant-ui/assistant-ui)  
  - [Ant Design X](https://x.ant.design)  
  - [Stream Chat React AI SDK](https://getstream.io/chat/docs/sdk/react/guides/ai-integrations/stream-chat-ai-sdk)  
  - [Shadcn React AI 组件（AI Chat）](https://www.shadcn.io/ai)  

### 可观测性

- <http://logfire.pydantic.dev/docs/comparisons/langfuse/>



### workflow

- [Trigger.dev](https://trigger.dev)
  - ✅ 基于云事件的无服务器工作流引擎，支持 TypeScript/JavaScript/Python 等语言，有 UI 控制台。
- [temporalio/temporal](https://github.com/temporalio/temporal)
  - ✅ Go/Java/TS/Python/.NET 需部署 用法类似Workflow DevKit
- [Workflow DevKit ](https://useworkflow.dev/)
  - CLI + UI + OTel 类库化 vercel 的 nextjs绑定
- https://github.com/PrefectHQ/prefect
  - ✅ python

github action

- [probot/probot](https://github.com/probot/probot) 
  - app.on("issues.opened", async (context) => {})
  - 非常适合lib使用

## 类似想法

- [ralph-tui](https://github.com/subsy/ralph-tui)
- <https://github.com/mikeyobrien/ralph-orchestrator>
  - 定位：改进版 Ralph Wiggum 技法的自主 AI 编排器，支持多 AI 后端，有交互式 TUI。


## doc确定性

下载同步: git clone依赖的原始项目
预处理：利用 Repomix 等工具将仓库“脱水”，剔除干扰，保留骨架。
符号化：利用 tree-sitter 等工具生成精确的符号表，作为 AI 的导航地图。
动态注入：不追求一次性处理所有代码，而是通过 LLM 编排，根据场景动态加载相关的代码片段。
标准化导航：在库中引入类似 llms.txt 的 AI 友好型说明文件，作为知识库的“高速缓存”。

### doc 确定性 ref
-  nodejs
  - `npm query`的解析器: <https://github.com/npm/cli/tree/latest/workspaces/arborist>
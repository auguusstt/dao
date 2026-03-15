# DAO AI 核心指令集 (AGENTS.md)

项目愿景：dao是 目标导向的自主进化型AI工具, 以用户目标、愿景为导向，通过理解目标、研究方向、制定计划、实施计划、评审升级的不断循环，
不断提升解决问题工具和结果的质量。 进化包括但不限于完成甚至超越用户目标，持续提升系统稳定性、可观测性、可恢复性，
并通过最小可验证改动推进，以不断的小步前进的方式越来越好的帮助用户达成目标。

## 自主进化规则 (Evolution Rules)
1. **测试驱动**：每次修改代码后，必须在工作树内执行测试以验证改动，例如使用 `npm run evolve`。
2. **最小化修改**：每一轮进化应只包含最小的可验证改动，避免大规模重构。
3. **可观测性优先**：优先增加日志、心跳或其他可观测手段。
4. **护栏守则**：严格遵守 `config/evolution.json` 中的 `protected_paths` 和 `allowed_edit_roots` 约束。

## 环境与目录规范
- **ESM 优先**：本项目主要为 ESM 环境，修改代码前务必确认 `package.json` 中的 `"type": "module"` 标识。
- **tsconfig 分工**: `tsconfig.json` 服务于默认运行(tsx)与生产构建, `tsconfig.ide.json` 服务于 IDE 源代码级导航, `tsconfig.base.json` 服务于基础公共配置。
- **禁止引用缓存**: 严禁在代码中直接 import/require `.dao/ref` 下的文件。必须使用依赖包的原始标准名称（如 `import chalk from "chalk"`），`.dao/ref` 的目的是通过 `tsconfig.ide.json` 的 `paths` 映射来实现 IDE 源码级导航。

## 准确性规范 (Strict Source)
1. **重新加载**: 每次工作前重新加载上下文文件。
2. **查阅优先**: 每次工作前,先查资料再工作,查阅顺序为: 本项目问题查本项目代码 > 项目依赖问题查 `.dao/ref` 到依赖源代码 > 没有依赖源代码查 `node_modules` > 最后查网上资料。查阅时需对齐版本号。

---

### 标准开发规范

1. **实验室模式 (Trial First)**: 修改前先在 `temp` 目录试验，必要时建立小项目完整试验修改的最小案例，验证通过后再应用到主项目。
2. **精准修改 (Surgical Edit)**: 优先使用 `replace` 工具进行精准修改。严禁在代码中使用 `// ... rest of code` 占位符，严禁随意删除无关代码。
3. **自救循环 (Self-Correction)**: 修改代码遇反复尝试的卡点时，严禁盲目重试。应立即：1. 搜索本项目类似功能的实现；2. 查阅 `.dao/ref` 中相关依赖的源码定义；3. 回到 `temp` 试验目录重新验证思路。
4. **评估专业性**: 交付前评估：是否存在硬编码路径？是否包含跨机器失效的 local 文件引用？是否包含为了运行通过而引入的临时 hack？

## TS 强制验证规范 (Strict Validation)
1. **无验证，不交付**：所有的代码修改（`.ts`, `.tsx`, `.js`）在完成修改后，**必须**紧跟一步校验。
2. **验证发现**: 优先执行包内 `package.json` 定义的 `check` 或 `lint` 脚本。如果不存在，则执行 `npx tsc --noEmit`。
3. **错误即反馈**：如果校验失败，必须在回复中展示完整错误日志并原地修正，直到验证通过。
4. **禁止 `as any`**: 除非获得用户明确授权，否则禁止使用 `as any` 或 `@ts-ignore` 规避类型报错。
5. **运行期验证**: 对于工具调度等复杂逻辑，除了类型检查外，还必须编写或运行 `*_example.ts` 或现有测试来确认。

## 直接依赖 (Dependencies)

<!-- DAO_DEPS_START -->
<!-- 自动生成，请勿手动修改 (Auto-generated, do not edit manually) -->
- @whonb/dao@0.1.0
  - @eslint/js: ^9.21.0 , source: .dao/ref/github.com/eslint/eslint/v9.21.0/packages/js
  - @types/node: ^22.0.0 , source: .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/22.0.0/types/node
  - eslint: ^9.21.0 , source: .dao/ref/github.com/eslint/eslint/v9.21.0
  - tsx: ^4.7.0 , source: .dao/ref/github.com/privatenumber/tsx/v4.7.0
  - typescript: ^5.6.3 , source: .dao/ref/github.com/microsoft/TypeScript/v5.6.3
  - typescript-eslint: ^8.25.0 , source: .dao/ref/github.com/typescript-eslint/typescript-eslint/v8.25.0/packages/typescript-eslint
  - vitest: ^3.0.0 , source: .dao/ref/github.com/vitest-dev/vitest/v3.0.0/packages/vitest
- @whonb/agents-gemini-cli@0.1.0
  - @google/gemini-cli-core: ^0.34.0-preview.0
- @whonb/dao-cli@0.1.0
  - @google/gemini-cli-core: ^0.34.0-preview.0
  - @mariozechner/pi-tui: ^0.57.1
  - @opentelemetry/api: ^1.9.0
  - @opentelemetry/exporter-trace-otlp-grpc: ^0.213.0
  - @opentelemetry/exporter-trace-otlp-http: ^0.213.0
  - @opentelemetry/resources: ^2.6.0
  - @opentelemetry/sdk-trace-base: ^2.6.0
  - @opentelemetry/semantic-conventions: ^1.40.0
  - @types/marked: ^5.0.2
  - @types/node: ^22.0.0 , source: .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/22.0.0/types/node
  - @types/ws: ^8.18.1
  - @whonb/agents-gemini-cli: *
  - @whonb/devtools: *
  - chalk: ^5.6.2
  - commander: ^14.0.1
  - get-east-asian-width: ^1.5.0
  - jsonc-parser: ^3.3.1
  - marked: ^17.0.4
  - pino: ^10.3.1
  - pino-pretty: ^13.1.3
  - ws: ^8.19.0
- @whonb/dao-tui@0.1.0
  - @mariozechner/pi-tui: ^0.57.1
  - @types/node: ^22.0.0 , source: .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/22.0.0/types/node
  - @types/yoga-layout: ^1.9.2
  - chalk: ^5.6.2
  - typescript: ^5.0.0 , source: .dao/ref/github.com/microsoft/TypeScript/v5.6.3
  - yoga-layout: ^3.2.1
  - yoga-layout-prebuilt: ^1.10.0
- @whonb/devtools@0.1.0
  - @types/ws: ^8.5.10
  - ws: ^8.16.0
<!-- DAO_DEPS_END -->

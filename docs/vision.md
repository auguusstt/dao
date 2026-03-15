# dao 愿景

如何能完成agent自我进化？

比如，你突然冒出个想法：
- 希望有一个属于个人的新闻情报系统，每天按自己的喜好不断的搜集时事热点，预测突发事件
- 希望有一个属于自己的量化股票系统，每天不断帮你预测股票，并可以对以往它的预测进行验证打分
- 希望有一个属于自己的工作提示系统，每天汇总各工作群、邮件、备忘录的重要事件和工作规划

这些想法，可能只是一个小工具，也可能是个大项目，但核心想法是，这个工具被一个ai agent每天不断的自我升级、进化出更好用的功能，你可以观察它正在做哪些改进？也可以告诉他你的一些想法，也可以完全不管，只说你的目标和愿景，让他自己去折腾，你只打开工具，享受成果。

这能做到吗？

## 如何做到

假设这个系统叫dao，道生一，一生二，二生三，三生天下，dao 是一个智能体应用，暂定为cli命令行工具，封装各种编程agent cli或其他工具，比如geminicli/qwen/codebuddy/pi/opencode 等，这些大厂开发的工具本身就具有极高的使用价值和不错的免费额度。

在一个目录中输入
```bash
dao
```

他会提示你输入你的目标:

> 本目录无`DAO.md`, 初始化项目, 你的愿景是什么? 你要达成什么目标? 请输入: __________  

然后dao会：
- 生成`DAO.md`, 包含: 你的愿景, dao 运转模版提示词
- 提示你可用的agent tools工具集, 按照你目前安装的情况帮你初始化 `.gemini`/`.qwen`等目录

在至少具备最少一个可用agent tools的情况下，生成第一个 `dao.ts` 模版，

并进入进化循环:
while(true){
    run dao.ts
}

dao 本质并不添加任何额外的流程、魔法、提示词，只是原本的构成一个初始循环，而具体每一次循环做什么进化，要看你自己项目里的dao.ts脚本及其配置了。

最好的畅想是：这个循环按照项目愿景和目标，进入一种自我寻找方向，寻找出路，自我衡量，自我编程去达成任务，


## 计划支持的 agents tools

- code agent
    - qwen-code: `npm i -g @qwen-code/qwen-code`
    - geminicli: `npm i -g @google/gemini-cli`
    - codebuddy(@tencent-ai/codebuddy-code): `npm i -g @tencent-ai/codebuddy-code`
    - codex: `npm i -g @openai/codex`
    - pi: `npm i -g pi-coding-agent`
    - opencode: `npm i -g opencode-ai`
- ...

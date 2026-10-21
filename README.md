# WetFlow

面向湿实验的工作流 Agent，集成人工审批、实验数据记录、公开文献检索与生物过程建模。

- **搜索建库**：研究档案、Europe PMC / arXiv / GEO 搜索、来源分层、带原文证据的实验数据、运行级隔离和只读 SQL 查询。
- **Agent 工具**：根据研究目标搜索、分页阅读来源、整理数值记录，并导出到建模工作区。
- **生物过程建模**：Monod 批次模拟、生长曲线拟合、结果下载、预测登记与实验关联。
- **研究扩展**：通过独立插件比较已保存的 MD 接触报告；Education 工具复用项目资料和来源引用，并将完整 WEAVE 设计循环用于小学 DNA 活动规划。
- **回答与文献阅读**：支持 Markdown 表格、列表与引用链接；按名称指定文档时优先检索该文档；研究档案和来源全文可折叠阅读。

## 运行

需要 Node.js ≥22.19 和 Python 3。

```sh
npm ci
npm run build
npm start
```

打开 http://127.0.0.1:4310 。在「搜索建库」保存研究档案并启用研究模式，可手动检索或在 Agent 对话中要求整理公开数据。对话模型在界面中配置，本地 SQL 和数值建模不需要模型 API。

Europe PMC 支持可获取的开放全文；arXiv 当前读取摘要，GEO 当前提供数据集元数据。元数据和摘要不会被当成可直接导入的实验数值。拟合导出要求有来源支持的 biomass/g/L 时间序列。

自动检索到的文献片段发送给云端模型默认关闭；需要时在模型设置中明确开启，或为 CLI 设置 `WETFLOW_ALLOW_DOCUMENT_EXCERPTS=true`。研究来源显示文章自身的许可信息，缺失时标为未知；拟合导出只包含时间和 biomass 数值，并附来源引用信息。

## 检查

```sh
npm run check
```

包含 TypeScript 检查、生产构建及测试。2026-10-20 的生产构建通过，回归验证通过 197 项测试（25 个测试文件），其中包括插件生命周期与两个科学扩展的测试；另有 1 项审计链测试未在本轮执行。三个科学扩展离线演示也已通过。更新内容见 [CHANGELOG.md](CHANGELOG.md)。

## Plugin lifecycle

Evidence, Research, Modeling and Experiment are independently loadable Cordis plugins. Open **Plugin lifecycle** in the workbench to inspect the live registry, load/unload a module and call a modeling tool before and after removal. Run `npm run demo:plugins` to export a reproducible registry comparison. See [plugin lifecycle and test instructions](docs/plugin-lifecycle.md).

## Scientific extensions

MD 比较与 Education 插件使用相同的工具接口，分别封装报告校验和教育规划要求，复用已有项目与服务。查看 [扩展设计与复现说明](docs/scientific-extensions.md)。

```sh
npm run demo:feeds
npm run demo:design
npm run demo:education
```

以上演示默认不调用模型 API，使用仓库自带的输入并将结果写入 `.wetflow/demos/`。Education 当前示例仅包含一项 30 分钟小学 DNA 活动设计；WEAVE 表示完整设计循环，核验和改进仍需后续课堂证据。需要重新生成 Agent 回答时，按说明显式使用 `--live` 并配置模型凭据。

### Context budget

The workbench's **模型上下文** panel includes an editable token budget and Save button. The default is 128,000, with an accepted range of 1,024–1,000,000 tokens. Changes apply to subsequent requests and survive restart in `.wetflow/context-settings.json`. A saved UI setting takes precedence over `WETFLOW_CONTEXT_TOKEN_BUDGET`; an explicit server `contextTokenBudget` option takes precedence over both on startup.

This is WetFlow's estimated base-context assembly budget, not a guarantee of the selected model's capacity or the complete request's exact token count. System instructions and tool definitions also consume context; tool-call continuations add their own messages. Choose a value supported by your provider. Existing document-sharing preferences remain in effect. Older original messages are retained whenever they fit; extracted memory is used when the budget requires compaction.

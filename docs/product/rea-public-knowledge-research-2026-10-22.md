# REA 专员公开资料研究交付

来源：经用户授权委托通用“REA专员”线程；2026-10-22 读取其实际完成的研究答复。以下为研究交付，不是产品实机验收，也不改变本项目发布门禁。

建议 H5AI 借鉴四家的交互能力，继续以现有的**“材料解析→商家核对→应用草稿→测试→不可变 Release→固定 slug”**作为发布主线。最值得吸收的是：Dify 的分类与检索测试、RAGFlow 的解析核对、FastGPT 的 FAQ 表格导入、Fin 的问题反馈到知识修订闭环。

研究日期：2026-10-22。以下 **D＝已实际 fetch 的官方文档声明，C＝已读取公开源码，U＝本轮未验证**。未登录产品、未运行实例，因此“复现步骤”是供后续验证的操作路径，不能当作已完成的功能测试。

| 对象                                | 导入、分类与批量维护：已确认事实                                                                                                                                                                                                                                                                                                                                                                                                                           | 复查路径                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Dify Knowledge／Cloud 文档**      | **D** 本地文件和公开网页可导入；网页依赖 Firecrawl/Jina 等数据源，支持先预览抓取结果。元数据支持字符串、数字、时间及批量修改。普通分块适用于 FAQ，但本轮没有证实通用表格能自动转成可靠的商品/服务记录。[网页导入](https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/import-text-data/sync-from-website)、[元数据批量维护](https://docs.dify.ai/en/cloud/use-dify/knowledge/metadata)                                                       | Knowledge→创建知识库→选择文件/网页→预览；选中文档→Metadata→批量编辑，检查“仅已有字段”与“全部所选文档”的区别。 |
| **RAGFlow／1.0.0-rc2 文档**         | **D** 有文档、HTML、Table、Q&A 等解析模式；Q&A 按问答对、Table 通常按行分块。文档列表支持搜索过滤、批量解析、启停、元数据维护和删除；外部来源同步可处理新增、修改，启用相应选项后处理源端删除。[解析配置](https://ragflow.io/docs/v1.0.0-rc2/dataset_configuration)、[批量维护](https://ragflow.io/docs/v1.0.0-rc2/files_dataset_document_management)、[同步更新](https://ragflow.io/docs/v1.0.0-rc2/add_data_source/add_to_knowledge_base_and_sync)       | Dataset→Files→上传→选择 Table/Q&A→解析→打开文档核对；选中多份文档检查批量操作。                               |
| **FastGPT／当前文档与固定提交源码** | **D+C** FAQ 模板支持 CSV/XLSX，字段为 `q/a/index/metadata`；XLSX 要单工作表、无合并单元格。**D** 文档支持上传后预览分块；站点批同步和集合标签在所查文档中标为商业版功能。[模板格式](https://doc.fastgpt.io/zh-CN/guide/dataset/template)、[文档预览流程](https://doc.fastgpt.io/zh-CN/guide/getting-started/quick-start)、[站点同步](https://doc.fastgpt.io/en/guide/dataset/websync)、[集合标签](https://doc.fastgpt.io/en/guide/dataset/collection_tags) | 知识库→模板导入→准备两行 FAQ→导入→检查数据及训练状态；另测合并单元格、多个 sheet 等错误输入。                 |
| **Intercom Fin／当前 SaaS 文档**    | **D** 支持公开网页、PDF、文章和 snippet；有统一搜索、文件夹和批量状态/分类操作。网页内容在 Intercom 内只读，须回源修改后同步。**U** 通用 CSV/XLSX 直接作为 Fin 知识批量导入，本轮没有取得充分证据。[知识管理](https://www.intercom.com/help/en/articles/9357912-knowledge-explained)、[网页同步与维护](https://www.intercom.com/help/en/articles/9357945-sync-and-manage-websites)                                                                         | Knowledge→Sources→网页/PDF；Content→搜索过滤→选择多项→批量操作；修改网页源后手动重新同步。                    |

FastGPT 的源码互证固定在提交 `e8b601b3c90ac1532269de4d984978d06da70573`：导入解析器明确限制 CSV/XLSX，并检查 sheet、合并单元格和表头；创建接口调用该解析器后建立集合。只证明这段实现存在，未证明部署实例行为。[解析器源码](https://github.com/labring/FastGPT/blob/e8b601b3c90ac1532269de4d984978d06da70573/packages/service/core/dataset/importFile.ts)、[创建接口源码](https://github.com/labring/FastGPT/blob/e8b601b3c90ac1532269de4d984978d06da70573/projects/app/src/pages/api/core/dataset/collection/create/template.ts)

| 对象        | 纠错、测试、引用及恢复：重要边界                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dify**    | **D** 可编辑、启停和归档文档/分块；删除不可撤销。检索测试参数仅对当前测试生效，测试与应用检索记录可查看。**D** 版本历史属于 Workflow/Chatflow，不能据此推断整份知识库也被快照冻结。**U** 整库原子恢复、语义冲突和业务过期自动识别。[知识维护](https://docs.dify.ai/en/cloud/use-dify/knowledge/manage-knowledge/maintain-knowledge-documents)、[检索测试](https://docs.dify.ai/en/cloud/use-dify/knowledge/test-retrieval)、[应用版本范围](https://docs.dify.ai/en/cloud/use-dify/build/version-control)                                             |
| **RAGFlow** | **D** 可将分块与原文位置对照，并编辑、添加关键词、启停；检索测试可区分“没召回”与“召回正确但生成不佳”。测试参数不会自动同步至正式应用。**U** 与 H5AI 等价的整库 Release 发布和恢复、自动业务冲突/过期识别。[分块核对](https://ragflow.io/docs/v1.0.0-rc2/chunk_parsing_results_and_knowledge_fragment_management)、[检索测试](https://ragflow.io/docs/v1.0.0-rc2/retrieval_testing)                                                                                                                                                                   |
| **FastGPT** | **D** 引用阅读器可打开原文并定位引用，匿名分享可限制为只显示引用片段。**U** 本轮未充分验证批量正文覆盖、全库矛盾检测、不可变知识版本恢复；不能把备份导入等同于原子回滚。[引用阅读器](https://doc.fastgpt.io/en/guide/chat/quoteList)                                                                                                                                                                                                                                                                                                                 |
| **Fin**     | **D** Pro 附加功能可根据未解决对话提出新增、修订、重复和矛盾建议，展示相关对话及内容，由人接受或拒绝。公开文章可恢复旧版为新草稿再发布；snippet 没有同样的草稿流程，保存后默认供 Fin 使用。两种内容不能混为同一发布模型。[内容建议](https://www.intercom.com/help/en/articles/11394959-use-ai-powered-content-recommendations-to-improve-fin)、[文章版本恢复](https://www.intercom.com/help/en/articles/9357931-create-and-manage-public-articles)、[snippet 生效规则](https://www.intercom.com/help/en/articles/8074407-create-and-manage-snippets) |

重复、矛盾和过期应分开定义。Fin 的网页同步明确会排除相同内容，但这不等于跨材料价格矛盾已经解决；Dify Cloud 的“不活跃文档自动停用”也不代表内容已过期。[Fin 重复页面说明](https://www.intercom.com/help/en/articles/9357945-sync-and-manage-websites)、[Dify 停用规则](https://docs.dify.ai/en/cloud/use-dify/knowledge/manage-knowledge/maintain-knowledge-documents)

**适合 H5AI 的建议如下，均为本项目设计建议。**

| 优先级            | 建议                                                             | 商家体验与实现边界                                                                                                                                |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**            | 四入口统一为待核对材料：文档、公开网页、表格、手填 FAQ           | 显示解析成功/失败、来源和预览；FAQ 表格提供“问题、答案、分类”模板，避免要求商家填写 JSON。                                                        |
| **P0**            | 导入结果展示新增、重复、疑似冲突、无法识别                       | 完全重复可按规范化内容摘要识别；价格、营业时间、退换规则冲突须带门店、服务和有效期上下文，由商家决定。禁止静默覆盖。                              |
| **P0**            | 分类搜索和安全批量操作                                           | 提供商品/服务、价格、营业时间、售后等分类；批量移动、停用、应用到草稿前显示影响数量与内容。                                                       |
| **P0**            | 草稿问答测试＋来源定位＋未命中处理                               | 每次展示答案依据和所测草稿版本；区分未命中、命中但答错、模型调用失败。未命中问题可转 FAQ 草稿。                                                   |
| **P0**            | 发布与恢复完整闭环                                               | Release 固定知识内容、来源引用及影响回答的配置；Worker 每次请求绑定一个 Release。恢复旧内容先进入草稿，测试后生成新 Release，固定 slug 保持一致。 |
| **P1**            | 网页增量同步和更新差异                                           | 回源发现变化后形成待核对差异；不直接改线上 Release。                                                                                              |
| **P1**            | 语义重复/矛盾建议、有效期和复核提醒                              | 参考 Fin“相关来源＋原因＋接受/拒绝”；模型判断只作建议。                                                                                           |
| **不适用当前 P0** | 通用工作流画布、复杂解析参数、大量企业连接器、自动改写后立即上线 | 增加商家学习成本，并扩大当前发布验证范围。                                                                                                        |

Fin 的“Improve answer→查看相关来源→新增或修改知识”尤其值得借鉴，但 H5AI 应让修订先进入草稿。[官方复查路径](https://www.intercom.com/help/en/articles/8403222-debug-fin-ai-agent-answers)

生产发布前建议由 A0 在本项目完成五项闭环验收：

1. 用虚构商家资料完成四种导入，核对行数、来源、重复和冲突提示。
2. 修改草稿后，固定 slug 的线上答案仍使用原 Release。
3. 草稿测试能回答资料内问题、定位引用，并对资料外问题明确未命中；修订 FAQ 后可重新测试。
4. 发布后实际 Worker 调用千问，记录 Release ID、来源 ID、成功/失败状态，验证缓存与新版本一致。
5. 恢复旧内容并重新发布后，同一 slug 使用恢复后的知识；失败发布及重复点击不会产生半成品或重复生效。

本轮完成的是公开资料和源码研究；未读取 H5AI 业务代码、未修改文件或服务器，也未执行生产发布。

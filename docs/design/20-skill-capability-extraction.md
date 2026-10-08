# Skill 能力沉淀与 WorkBuddy 接入设计

本设计确认当前多商家边界，并把已实现能力按“可独立使用的 Skill”“需要账号的业务连接器”“可切出的底层组件”分开。目标是让商家用自然语言准备客服资料、继续管理已有客服，同时不把运营权限、秘密凭据或未经确认的发布操作带进 Skill。

## 一 当前业务模式核对

运营端只保留一个配置好的管理员账号，不增加运营多账号、角色管理或邀请体系。该账号可多次开通商家，每次正常创建得到独立商家 ID、领取邀请及审计记录；同一幂等请求不会重复开通。

每个商家后台都是独立的逻辑空间，不是另部署一套服务器。各商家共享应用和 MySQL，但读取和修改都带商家作用域并复核成员权限。

| 对象 | 关系与边界 | 实现证据 |
| --- | --- | --- |
| 运营账号 | 一位运营者可创建多个商家 | `apps/ops-web/app/operator-auth.ts` 单账号配置；`platform-provisioning-repository.ts` 每次生成独立 ID |
| 商家后台 | `/{merchantId}/功能页面`，不靠链接本身授予权限 | `apps/merchant-web/app/tenant-paths.ts`、`tenant-data.ts` 和各功能入口 |
| 负责人账号 | 同一手机号和密码账号可通过独立邀请获授权多个商家 | `merchant-access-repository.ts` 已有凭据复用需验证原密码，成员关系分别建立 |
| 商家登录会话 | 绑定一个目标商家，不能借当前会话跨到其他商家 | 会话与成员关系同时匹配 `s.merchant_id`，写操作另检查 CSRF |
| 客服与咨询 | 属于指定商家，不能互读或互改 | 草稿、知识、发布及咨询仓储的作用域校验；已有双商家浏览器验收 |

同一负责人管理多个商家时，须用目标商家的专属链接登录；通用登录页目前没有商家选择器。同一浏览器使用一套商家 Cookie，登录另一个商家会改变当前会话，旧页操作会被拒绝而不是静默改写到新商家。若将来要求同时打开多个商家的独立登录会话，再单独设计会话切换或多上下文方案，不将它等同于目前“可创建多个商家”的需求。

本轮增加两项定向回归：同一运营账号开通两个不同商家；同一验证账号关联两个商家时通用登录拒绝代选、明确目标登录分别成功、无权限目标拒绝签发会话。账号密码验证不等于短信验证手机号所有权，当前没有短信验证能力。业务代码不因此改动。

公开站点只读核对：通用商家登录 HTTP 200，匿名访问商家帮助 HTTP 307 跳转登录，公网 `/mcp` HTTP 404。最后一项说明直连仍未上线，不是可调用的已发布 MCP 服务。

## 二 已落地的第一批独立 Skill

每个目录自包含，不要求同时安装其他 Skill，不携带 `mcp.json`、服务器地址凭据、SSH 配置或千问密钥。由 WorkBuddy 宿主当前模型处理用户授权的材料，不承诺模型推理完全离线或不涉及宿主的数据处理。

| Skill | 用户输入与输出 | 当前状态 |
| --- | --- | --- |
| h5cs-material-writer 客服资料撰写 | 简述或现有字段 → 详细文案／备选、待核对事实 | 指令和字段资源已实现，构建本地导入候选包 |
| h5cs-faq-builder 知识和 FAQ 整理 | 商家材料 → 有依据的问答、缺失项和来源冲突 | 指令资源已实现，不上传知识 |
| h5cs-release-check 发布前检查 | 草稿及真实回答记录 → 问题、证据、测试与修订建议 | 指令资源已实现；没有真实回答时明确未实测 |
| h5cs-web-guide H5 创建与使用引导 | 首次生成／已有客服 → 准备资料、明确本人 Web 操作步骤 | Web 协同版已实现；不自动调用 API 或发布 |

源目录为 `integrations/workbuddy/standalone-skills/`，每个包包含单个技能根目录及 `SKILL.md`、必要的 `references/`。没有顺带索取本平台管理员账号、WorkBuddy ID 或 API Key。

四个包可以单独导入测试，尚未经真实 WorkBuddy 客户端导入、自动触发和对话执行验收，也没有提交市场审核。源码格式校验、字段约束校验和 ZIP 回读校验不能替代这些实机结果。

## 三 全项目可进一步独立沉淀的能力

| 能力 | Skill 或组件的形态 | 已有可复用来源 | 依赖与拆分判断 |
| --- | --- | --- | --- |
| 客服资料撰写 | 独立 Skill；后续可做文字服务 | WritingInput／Result、字段限制、writing-prompt、填写助手 | Skill 已独立；API 服务仍在 Worker，模型网关与限流需明确封装后再切服务 |
| 商品知识与 FAQ 整理 | 独立资料 Skill | 文字知识、事实边界、电商预设 | 首版 Skill 已独立；文件解析和自动入库尚未实现，不能宣传为完整 RAG |
| 行业资料采集 | 行业专用 Skill 或版本化材料包 | IndustryTemplateRepository、retail-preset、requiredMaterials／Policies | 可先按品类切材料包；通用常识不能变成商家事实，本轮不批量制作其他行业 |
| 发布前回答检查 | 独立检查 Skill 与测试工具包 | PreviewFacts、conversation-prompt、阶段／公网 smoke | 审查 Skill 已独立；真实试聊、费用及发布仍需授权服务与明确确认 |
| 商家开通及账号授权 | 平台业务服务，不作为公开无鉴权 Skill | invitation、membership、platform session、provisioning audit | 留在后端；运营开通和商家操作的权限不能合并 |
| 草稿确认与版本发布 | 连接器工具及复用生命周期服务 | AssistantLifecycleRepository、修订 CAS、release snapshot、幂等 | 需要可信商家上下文；发布应是独立权限、当前版本和单独确认，不纳入首批自动能力 |
| 咨询跟进 | 只读总结／跟进建议 Skill；或受保护连接器 | MerchantConversationRepository、follow-up 状态 | 用户提供且脱敏的对话可做分析；在线读取／改状态须授权，不等同实时人工客服 |
| 帮助与操作引导 | 独立引导 Skill 或共享帮助内容模块 | HelpTopic、manualText、任务型帮助中心 | Web 引导 Skill 已独立；内容应跟随真实按钮与功能更新，不能编造链接 |
| 部署与发布检查 | 内部运维 Skill／发布工具包 | health、Nginx 路由回归、镜像证据、回滚脚本 | 仅内部使用；凭据、服务器参数和云资源不打包给商家，不自动创建费用资源 |

优先切出不依赖租户数据的字段协议、事实边界、提示词、检查用例和资料模板；暂不为了“做 Skill”拆成大量微服务。MySQL 业务真值、成员授权、幂等、修订和审计保持服务端统一约束。

## 四 连接器方向及用户身份

WorkBuddy 的 Skill 本身是指令与资源，不是身份凭证。安装 Skill 不会自动得到可信商家权限，也不能因为用户自报手机号、昵称或商家 ID 就给他管理入口。

直连版沿用 MCP + Skill 路线。基础授权以本平台已验证账号、实时成员关系和明确选择的商家为准；使用本平台 OAuth／PKCE 给 WorkBuddy 公共客户端签发限权 Connector Token。普通商家不需要运营账号，也不需要向对话发送密码或令牌。

WorkBuddy 第三方应用 OAuth／Open API 是另一套可选能力。如果确实需要可信 WorkBuddy `open_id` 或 Open API，才接入正式第三方应用并从服务端换票取得。它不是四个纯资料 Skill 的前提，也不应无条件变成手机号兜底登录或基本 MCP 接入的前提。现有代码的 ExternalIdentity 与运行时认证装配需要据此完成适配，不能只启用一项开关就声称打通。

多商家由服务端返回当前账号真正有权管理的列表，用户明确选择一项；再选该商家的客服。商家选择、客服选择和创建新商家是不同动作，不能由模型混用。成员撤销、商家暂停或授权失效后旧连接不得继续读取或写入。

## 五 接下来的实施顺序

1. 完成本地 Skill 包，逐个在真实 WorkBuddy 客户端导入。验证触发、单轮问答、修改、取消、不确定事实、秘密误粘贴及上传材料的指令攻击；保留脱敏结果。
2. 将既有 Connector OAuth 安全骨架接到平台真实登录、商家选择与 consent、Token 验证、刷新和撤销，再把已验证商家作用域接入现有生成与管理应用服务。先预发布，不改现有 Web 流程。
3. 先开放准备／创建可编辑草稿和打开有权管理的后台；受保护读写都核对真实账号、商家和客服作用域。超时结果未知时用原幂等上下文核对，不盲目重新创建。
4. 做 WorkBuddy 实机授权及双商家验收，通过后再开放正式 HTTPS MCP 路由。准备图标、隐私与权限用途、支持与撤销说明、版本兼容范围和审核材料，再提交市场审核。

本轮没有安装个人 Codex Skill、创建云资源、修改服务器配置、打开公网 MCP 或提交市场审核。独立 Skill 候选包可先测试，但自动后台操作仍未完成。服务器上轮剩余约 3.3 GB 是构建前需再核对的运维余量，不为了本次纯指令包重新构建服务器镜像。

## 六 校验与交付

`scripts/skills/validate-workbuddy-skills.mjs` 按 WorkBuddy 官方元信息格式校验四个独立 Skill，并将资料字段限制与实际共享合同核对。它有负例测试，拒绝缺失引用、未知工具声明、秘密样式文件和重复元信息。

`scripts/skills/build-workbuddy-skill-packs.ps1` 只打包已验证的单个 Skill 文件，不复制整个项目。生成四个 ZIP 和摘要清单，再打开 ZIP 核对完整条目及每个文件 SHA256。已有输出不会被覆盖。

Codex skill-creator 的 `quick_validate.py` 只接受 Codex 专用前置信息，不能直接用它删除 WorkBuddy 必需的中英文说明、版本及作者字段；本项目按目标平台格式做补充验证，不将格式检查描述为模型行为验收。

## 官方依据

- [WorkBuddy 技能格式与子资源](https://open.workbuddy.cn/docs/skill)
- [WorkBuddy 客户端技能安装与开关](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)
- [WorkBuddy MCP 和 Skill 连接器及 OAuth](https://open.workbuddy.cn/en/docs/connector)

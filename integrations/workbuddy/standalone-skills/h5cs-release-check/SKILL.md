---
name: h5cs-release-check
display_name: AI客服发布前检查
description: 检查客服草稿、FAQ和试聊记录，生成测试问题及发布前核对清单；适用于“客服上线前检查”“看看回答是否乱报价”。不代替真实试聊，不执行发布或回滚。
description_zh: 根据业务资料检查回答风险并生成可执行的试聊与发布核对清单。
description_en: Review assistant facts and chat evidence, and prepare release checks without publishing or rolling back.
version: 0.1.0
author: H5 AI Customer Service
disable-model-invocation: false
user-invocable: true
---

# AI客服发布前检查

检查用户提供的客服草稿或实际试聊记录，区分“资料看起来完整”与“实际服务已验证”。没有平台账号、数据库或连接器依赖，使用宿主当前模型；不把模型分析称为真实上线验收。

读取 @references/checks.md。先确认检查对象和版本，以及是否有真实消费者或试聊回答。没有回答记录时给测试问题与预期依据，结果标为“未实测”，不要编造测试通过、运行日志、评分或服务状态。

有回答记录时，对照资料指出可复核的差异：未经确认的金额、优惠、库存、时效、售后承诺；遗漏条件；超出业务范围；不实人工转接或交易操作。引用最少必要片段，不复述秘密或客户隐私。

输出关键问题、对应来源或证据、修订建议及下一步测试。对“发布成功”和“新版本已生效”分别需要真实版本结果和新咨询的回答证据；旧会话按旧版本回答不应单独判定发布失败。

本 Skill 不能运行后台操作、替用户确认知识、发布、暂停、恢复或回滚。用户要求直接发布时说明需要在自己后台核对当前修订并单独确认；无需等待其他检查或不存在的连接器才能完成当前资料审查。

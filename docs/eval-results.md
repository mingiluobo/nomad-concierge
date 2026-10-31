# Interpretation evaluation

Run time: 2026-10-31T12:15:47.480Z
Dataset SHA-256: aa77d3aa1ec79be3c472af24a98cd6518d2e11caedc5fb38e672038026a13e22
Dataset: 68 cases; tags: ages, all-unsure, ambiguous-unsure, append-goals, arabic-number, assignment, background-fact, boundary, business, chinese-number, company-setup, correction, country-role, explicit-request, holdout, income, insurance, invalid-country, key, llm-only, mixed-information, multi-slot, negation, no-children, no-nationality-inference, not-professional-question, off-topic, ordinary-intention, preserve-unmentioned, professional, prompt-injection, question-variant, relative-duration, relevant-unrecognized, replace-goals, residence-status, rules, school, shared-nationality, short-answer, solo, targeted-unsure, tax-amount, timeline, unsupported-destination, unsure, unsure-forbidden, ux-professional, ux-scope, ux-time, visa-eligibility; key cases reviewed: 26/26
Models: rules: deterministic rules; remote: deepseek-chat; local: qwen2.5:7b-instruct
Prompt version: v4 (LLM only; rules: n/a)

| Engine | Intent accuracy | Update precision | Update recall | Unsure accuracy | Semantic accuracy | Average ms | Failures |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rules | 62/62 (100.0%) | 81/81 (100.0%) | 81/81 (100.0%) | 62/62 (100.0%) | 62/62 (100.0%) | 0.28 | {} |
| remote | 67/68 (98.5%) | 92/92 (100.0%) | 92/92 (100.0%) | 68/68 (100.0%) | 68/68 (100.0%) | 1024.89 | {} |
| local | 58/68 (85.3%) | 52/64 (81.3%) | 52/92 (56.5%) | 56/68 (82.4%) | 37/68 (54.4%) | 1209.11 | {"invalid_output":9} |

Update matches compare (slot, normalized value, operation); absent operations mean add for goals and set otherwise. Goal values are compared as sets. Semantic accuracy compares the resulting reconciled profiles. Failed cases remain in accuracy/recall denominators.

Skipped cases / engines:
- rules G044: llm-only case
- rules G045: llm-only case
- rules G046: llm-only case
- rules G047: llm-only case
- rules G048: llm-only case
- rules G049: llm-only case

## 第5次真实评估：范围与保留决定

- 冻结产品提交 `3da5f25fa72d46e641f1185a492a8ecb7d84cbc5`，提示词v4。唯一代码变更为提示词措辞和版本；单元测试仅同步两处版本元数据断言。业务规则、标准用例、校验器、规则引擎和评估算法均未修改。
- 本轮仅执行一次 `--engines rules,remote,local`，Node 24.22.2 / macOS arm64；两种模型各68次解释调用，无重跑、无额外真实产品冒烟。规则执行62条，其余6条按llm-only标签明确跳过。
- 数据集与v3字节相同（SHA-256见原始汇总），26/26 key用例已人工审核。作者未读取对照内容或真实评估结果；冻结前经独立规则一致性审查。旧40条与6条对照的文本、输入和期望在v2/v3/v4间完全相同（审核标记不参与评分）。
- 在评估开始前确定保留条件：remote旧40条严格通过高于29/40；remote独立6条不低于5/6；remote UX-04已通过的8条范围/事实用例G034–G036、G056–G059、G068不退步。local实际结果单独披露，不通过重复运行挑分数。
- 本次判定：**保留v4**。remote旧40严格39/40，对照6/6，remote范围/事实用例8/8。评估后不再修改提示词或继续调参。
- 第5次结果与下面历史v3、v2均为单次样本，不代表稳定性保证。耗时可能受服务和模型加载状态影响，没有为提高分数额外预热或延长应用超时配置。
- 评估直接调用各指定引擎，invalid_output等错误没有用规则回退结果替代；所有失败留在准确率与召回分母。真实模型评估不计入QA放行。

## v2 / v3 / v4：旧40条与独立6条

严格逐项通过同时检查意图、专业主题、更新的值和操作、unsure及合并后的档案，不能与仅比较档案的Semantic accuracy混用。旧40为G001–G043剔除因UX-04改变期望的G034–G036；独立6条为G044–G049。

| 分组 / 引擎 | 最终v2 | v3 | v4 |
| --- | --- | --- | --- |
| 旧40 / remote | 35/40 (87.5%) | 29/40 (72.5%) | 39/40 (97.5%) |
| 独立6 / remote | 5/6 | 5/6 | 6/6 |
| 旧40 / local | 未运行 | 18/40 (45.0%) | 19/40 (47.5%) |
| 独立6 / local | 未运行 | 3/6 | 3/6 |

local改善有限：总体invalid_output由12次降至9次，但旧40条内由5次增至7次，保护UX-04组仍仅4/8；不能把remote的8/8用于描述local。

历史旧40严格数由原始逐例未通过清单核算；未保存的历史分组耗时和完整逐例输出不重建、不估算。规则旧40在v2/v3/v4均40/40，独立6条一直按标签跳过。

| 对照 | remote v2 | remote v3 | remote v4 | local v3 | local v4 |
| --- | --- | --- | --- | --- | --- |
| G044 | 通过 | 通过 | 通过 | 通过 | 通过 |
| G045 | 通过 | 通过 | 通过 | 通过 | 通过 |
| G046 | 通过 | 通过 | 通过 | invalid_output | 内容不一致 |
| G047 | 通过 | 通过 | 通过 | 内容不一致 | 内容不一致 |
| G048 | 通过 | 通过 | 通过 | 通过 | 通过 |
| G049 | 内容不一致 | 内容不一致 | 通过 | invalid_output | 内容不一致 |

## v4 remote逐条未通过

严格通过67/68。以下分类只描述可观察差异，不推断模型内部原因。

| 用例 | 差异 |
| --- | --- |
| G012 | intent off_topic，期望provide_info |

## v4 local逐条未通过

严格通过32/68。以下分类只描述可观察差异，不推断模型内部原因。

| 用例 | 差异 |
| --- | --- |
| G001 | invalid_output（未得到合法Interpretation） |
| G004 | unsure ['childrenAges']，期望[] |
| G006 | 遗漏/不同值或op：["goals",["company"],"remove"]；多出/不同值或op：["goals",["residence"],"remove"] |
| G008 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G010 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G011 | intent provide_info，期望off_topic |
| G013 | 遗漏/不同值或op：["goals",["tax"],"add"]；多出/不同值或op：["goals",["company","residence","tax"],"add"] |
| G015 | unsure []，期望['timeline', 'incomeSource'] |
| G021 | 遗漏/不同值或op：["childrenCount",2,"set"] |
| G023 | invalid_output（未得到合法Interpretation） |
| G024 | 遗漏/不同值或op：["partnerNationality","CN","set"]；多出/不同值或op：["hasPartner",true,"set"] |
| G027 | invalid_output（未得到合法Interpretation） |
| G028 | invalid_output（未得到合法Interpretation） |
| G029 | invalid_output（未得到合法Interpretation） |
| G031 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G038 | 遗漏/不同值或op：["timeline","6to12m","set"]；多出/不同值或op：["hasPartner",true,"set"], ["timeline","gt12m","set"]；逐值校验丢弃1项 |
| G039 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G040 | 遗漏/不同值或op：["goals",["tax"],"add"] |
| G041 | invalid_output（未得到合法Interpretation） |
| G042 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G043 | invalid_output（未得到合法Interpretation） |
| G046 | 多出/不同值或op：["goals",["residence"],"remove"] |
| G047 | 遗漏/不同值或op：["goals",["education"],"set"]；多出/不同值或op：["goals",["education"],"remove"] |
| G049 | 遗漏/不同值或op：["incomeSource","freelancer","set"]；unsure []，期望['timeline'] |
| G050 | invalid_output（未得到合法Interpretation） |
| G051 | 遗漏/不同值或op：["destination","PT","set"], ["goals",["residence"],"add"] |
| G052 | 遗漏/不同值或op：["destination","PT","set"], ["goals",["residence"],"add"] |
| G053 | 遗漏/不同值或op：["goals",["company"],"add"] |
| G054 | 遗漏/不同值或op：["goals",["tax"],"add"] |
| G055 | invalid_output（未得到合法Interpretation） |
| G056 | 遗漏/不同值或op：["goals",["tax"],"set"]；多出/不同值或op：["goals",["tax"],"add"] |
| G057 | 遗漏/不同值或op：["goals",["tax"],"set"]；多出/不同值或op：["goals",["tax"],"add"] |
| G059 | 遗漏/不同值或op：["schoolPreference","public","set"] |
| G060 | 遗漏/不同值或op：["timeline","3to6m","set"]；多出/不同值或op：["timeline","lt3m","set"] |
| G067 | 多出/不同值或op：["timeline","gt12m","set"] |
| G068 | 遗漏/不同值或op：["goals",["healthcare"],"add"]；多出/不同值或op：["hasHealthInsurance",true,"set"] |

## 历史记录：第4次v3与此前v1/v2

下文保留此前报告、指标和逐条差异。其中“最终v3”“最终v2”、产品冒烟、审核状态及阶段性次数描述均指各自历史阶段，不表示当前候选仍采用该版本。没有重新执行这些历史实验；本轮仅新增前面的第5次v4结果。

### Interpretation evaluation

Run time: 2026-10-31T11:54:23.595Z
Dataset SHA-256: aa77d3aa1ec79be3c472af24a98cd6518d2e11caedc5fb38e672038026a13e22
Dataset: 68 cases; tags: ages, all-unsure, ambiguous-unsure, append-goals, arabic-number, assignment, background-fact, boundary, business, chinese-number, company-setup, correction, country-role, explicit-request, holdout, income, insurance, invalid-country, key, llm-only, mixed-information, multi-slot, negation, no-children, no-nationality-inference, not-professional-question, off-topic, ordinary-intention, preserve-unmentioned, professional, prompt-injection, question-variant, relative-duration, relevant-unrecognized, replace-goals, residence-status, rules, school, shared-nationality, short-answer, solo, targeted-unsure, tax-amount, timeline, unsupported-destination, unsure, unsure-forbidden, ux-professional, ux-scope, ux-time, visa-eligibility; key cases reviewed: 26/26
Models: rules: deterministic rules; remote: deepseek-chat; local: qwen2.5:7b-instruct
Prompt version: v3 (LLM only; rules: n/a)

| Engine | Intent accuracy | Update precision | Update recall | Unsure accuracy | Semantic accuracy | Average ms | Failures |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rules | 62/62 (100.0%) | 81/81 (100.0%) | 81/81 (100.0%) | 62/62 (100.0%) | 62/62 (100.0%) | 0.29 | {} |
| remote | 67/68 (98.5%) | 76/78 (97.4%) | 76/92 (82.6%) | 67/68 (98.5%) | 51/68 (75.0%) | 957.89 | {} |
| local | 53/68 (77.9%) | 45/52 (86.5%) | 45/92 (48.9%) | 53/68 (77.9%) | 32/68 (47.1%) | 1194.19 | {"invalid_output":12} |

Update matches compare (slot, normalized value, operation); absent operations mean add for goals and set otherwise. Goal values are compared as sets. Semantic accuracy compares the resulting reconciled profiles. Failed cases remain in accuracy/recall denominators.

Skipped cases / engines:
- rules G044: llm-only case
- rules G045: llm-only case
- rules G046: llm-only case
- rules G047: llm-only case
- rules G048: llm-only case
- rules G049: llm-only case

### 最终 v3 执行范围与解释

- 本节是用户追加授权的第4次真实评估：在产品提交 `2f6a91642d31c5ba27776cfaa3db48b3f28af4f8` 的独立临时副本执行评估入口 `--engines rules,remote,local`，Node 24.22.2 / macOS arm64。最终候选随后仅补充报告、README 和 QA 文件；产品实现与本轮相同。
- 前三次 v1/v2 实验使用原49条标准，历史数据完整保留在后文。v3 同步了资格问法、事实不扩张诉求和相对时长规则；当前为68条，且G034–G036按人工裁定移除了从事实自动添加诉求的期望。因此不能把两个全量百分比直接当作同一数据集上的提升或下降。
- G034–G036、G044–G049、G050–G068已按人工逐条审核结论标为 reviewed:true，26/26关键用例全部审核。G044–G049文本、输入、期望在提示词修改前冻结，之后仅修改审核标记。
- 规则实际执行62条，按标签跳过6条llm-only；远程和本地各实际执行68条，没有整引擎跳过。评估直接调用指定引擎，失败不会用规则结果冒充该模型结果。所有失败保留在意图/召回/语义分母中。
- 严格逐项通过：rules 62/62，remote 50/68，local 30/68。它同时检查专业主题、意图、更新操作/值、unsure和合并后档案；上方Semantic accuracy只比较档案，因此数字可能不同。
- 未改变文本或期望的旧40条（G001–G043剔除G034–G036），严格逐项通过为 v1 19/40 → 最终v2 35/40 → v3 29/40；历史两值由原始逐例清单剔除3条变更用例计算。v3在这部分出现退步，不能用扩充数据集掩盖。只运行一次最终样本，没有为提高分数重跑或调整提示词。
- 本地使用已安装的 `qwen2.5:7b-instruct`、Ollama OpenAI兼容入口及应用读取到的超时配置，未额外延长超时；产品冒烟先于评估，因此本轮耗时属于模型已有加载的状态。未另跑可选的local/v1对照。
- 以下失败分类仅依据实际输出差异，不推断模型内部原因；未保留完整模型请求或密钥。扫描所有工作树、进度文档所在目录与临时副本，除获准的原始配置文件外，密钥残留为0。真实模型结果不计入QA放行。

### 六条独立对照的版本结果

| 用例 | remote v1 | remote 最终v2 | remote v3 | local v3 |
| --- | --- | --- | --- | --- |
| G044 | 通过 | 通过 | 通过 | 通过 |
| G045 | 通过 | 通过 | 通过 | 通过 |
| G046 | 内容不一致 | 通过 | 通过 | invalid_output |
| G047 | 内容不一致 | 通过 | 通过 | 内容不一致 |
| G048 | 通过 | 通过 | 通过 | 通过 |
| G049 | 内容不一致 | 内容不一致 | 内容不一致 | invalid_output |

远程独立对照严格通过：3/6 → 5/6 → 5/6；local/v3为3/6。v3远程G049这次识别出freelancer，但遗漏tax诉求；v2同例遗漏的是freelancer，两次都不算通过。local G046/G049为结构失败，G047把替换education错误地写成remove。

### 最终 v3 remote：逐条未通过

| 用例 | 可观察差异 |
| --- | --- |
| G001 | 多出/不同值或op：["childrenCount",1,"set"] |
| G010 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G012 | intent off_topic，期望provide_info |
| G016 | unsure ['timeline', 'incomeSource']，期望[] |
| G024 | 遗漏/不同值或op：["partnerNationality","CN","set"] |
| G028 | 遗漏/不同值或op：["goals",["tax"],"add"] |
| G029 | 遗漏/不同值或op：["goals",["company"],"add"] |
| G039 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G041 | 遗漏/不同值或op：["goals",["company"],"add"] |
| G042 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G043 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G049 | 遗漏/不同值或op：["goals",["tax"],"add"] |
| G050 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G051 | 遗漏/不同值或op：["destination","PT","set"], ["goals",["residence"],"add"] |
| G052 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G054 | 遗漏/不同值或op：["goals",["tax"],"add"] |
| G055 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G060 | 遗漏/不同值或op：["timeline","3to6m","set"]；多出/不同值或op：["timeline","lt3m","set"] |

### 最终 v3 local：逐条未通过

| 用例 | 可观察差异 |
| --- | --- |
| G001 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G004 | unsure ['childrenAges']，期望[] |
| G006 | 遗漏/不同值或op：["goals",["company"],"remove"]；多出/不同值或op：["goals",["residence"],"remove"] |
| G008 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G010 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G011 | intent provide_info，期望off_topic |
| G013 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G016 | unsure ['timeline', 'incomeSource']，期望[] |
| G020 | 遗漏/不同值或op：["childrenCount",2,"set"] |
| G021 | 遗漏/不同值或op：["childrenCount",2,"set"] |
| G023 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G024 | 遗漏/不同值或op：["partnerNationality","CN","set"] |
| G027 | intent ask_professional，期望provide_info；professionalTopic tax_amount，期望无；遗漏/不同值或op：["goals",["tax"],"set"] |
| G028 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G029 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G031 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G038 | 遗漏/不同值或op：["timeline","6to12m","set"]；多出/不同值或op：["timeline","gt12m","set"]；逐值校验丢弃1项 |
| G039 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G040 | 遗漏/不同值或op：["goals",["tax"],"add"] |
| G041 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G042 | 遗漏/不同值或op：["goals",["residence"],"add"] |
| G043 | intent ask_professional，期望provide_info；professionalTopic visa_eligibility，期望无；遗漏/不同值或op：["goals",["residence"],"add"]；多出/不同值或op：["destination","PT","set"] |
| G046 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G047 | 遗漏/不同值或op：["goals",["education"],"set"]；多出/不同值或op：["goals",["education"],"remove"] |
| G049 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G050 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G051 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G052 | 遗漏/不同值或op：["destination","PT","set"], ["goals",["residence"],"add"] |
| G053 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G054 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G055 | invalid_output（未得到合法Interpretation；不是内容得分通过） |
| G056 | 遗漏/不同值或op：["goals",["tax"],"set"], ["hasHealthInsurance",true,"set"] |
| G057 | 遗漏/不同值或op：["goals",["tax"],"set"], ["hasHealthInsurance",true,"set"] |
| G059 | 遗漏/不同值或op：["goals",["education"],"add"], ["schoolPreference","public","set"] |
| G060 | 遗漏/不同值或op：["timeline","3to6m","set"]；多出/不同值或op：["timeline","lt3m","set"] |
| G062 | 遗漏/不同值或op：["timeline","lt3m","set"]；多出/不同值或op：["timeline","3to6m","set"] |
| G067 | 多出/不同值或op：["timeline","gt12m","set"] |
| G068 | 遗漏/不同值或op：["goals",["healthcare"],"add"]；unsure ['hasHealthInsurance']，期望[] |

### 本地模型产品路径与README实操

在同一产品提交的另一个独立副本，按README环境变量启动真实 `npm run dev`，动态端口和独立数据库，不配置远程Key。通过API创建选择local的咨询，再由浏览器核对实际界面。每轮耗时为发送至任务完成的墙钟时间，与解释器评估耗时不同。

| 轮次 | 墙钟耗时 | 实际结果 | 档案与回复 |
| --- | --- | --- | --- |
| 题面完整示例 | 7346ms | local invalid_output，回退rules | PT、配偶同行、四项诉求、6～12个月正确；未猜孩子人数，页面明确回退 |
| 补充本人/配偶中国籍及现居中国 | 2605ms | local/v3，无回退 | 两项国籍及现居国正确；未从国籍推断居留身份 |
| 修正配偶为葡萄牙籍及学校不确定 | 1833ms | local/v3，无回退 | 保留CN→PT修正记录，schoolPreference=unsure，回复正常 |

3轮均完成，但只有2/3满足“由local完成且无回退”。平均3928ms，首轮结构失败未通过重跑隐藏。本地接入与回退链可用，但这次观察不能证明本地模型稳定满足抽取格式或质量要求。浏览器显示“本地模型”、提示词v3、回退说明及修正/不确定档案；新咨询可选择本地模型，未追加第4轮推理。README已补全macOS/Linux与PowerShell配置命令；macOS实际操作，PowerShell仅静态核对。所有自有服务已停止。

### 历史：v1/v2 提示词改进实验（冻结49条标准）

以下为前三次实验的原始汇总和逐条结论；其中审核状态、G034–G036期望及“最终v2”均指该历史阶段，不表示当前v3仍使用旧标准。“没有第四次”仅描述当时三次实验，之后的额外授权执行见本文开头。

#### 原始 v2 汇总（49条）

Run time: 2026-10-31T11:13:05.063Z
Dataset SHA-256: 4d23757c66b9737d3f5f442f72625b323799f1dd75159c250089c2a57fd34085
Dataset: 49 cases; tags: ages, all-unsure, ambiguous-unsure, append-goals, arabic-number, assignment, business, chinese-number, company-setup, correction, country-role, holdout, income, insurance, invalid-country, key, llm-only, mixed-information, multi-slot, negation, no-children, no-nationality-inference, not-professional-question, off-topic, ordinary-intention, preserve-unmentioned, professional, prompt-injection, question-variant, relevant-unrecognized, replace-goals, residence-status, rules, school, shared-nationality, short-answer, solo, targeted-unsure, tax-amount, timeline, unsupported-destination, unsure, unsure-forbidden, visa-eligibility; key cases reviewed: 17/17
Models: rules: deterministic rules; remote: deepseek-chat
Prompt version: v2 (LLM only; rules: n/a)

| Engine | Intent accuracy | Update precision | Update recall | Unsure accuracy | Semantic accuracy | Average ms | Failures |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rules | 43/43 (100.0%) | 55/55 (100.0%) | 55/55 (100.0%) | 43/43 (100.0%) | 43/43 (100.0%) | 0.20 | {} |
| remote | 48/49 (98.0%) | 59/59 (100.0%) | 59/66 (89.4%) | 49/49 (100.0%) | 42/49 (85.7%) | 951.80 | {} |

Update matches compare (slot, normalized value, operation); absent operations mean add for goals and set otherwise. Goal values are compared as sets. Semantic accuracy compares the resulting reconciled profiles. Failed cases remain in accuracy/recall denominators.

Skipped cases / engines:
- rules G044: llm-only case
- rules G045: llm-only case
- rules G046: llm-only case
- rules G047: llm-only case
- rules G048: llm-only case
- rules G049: llm-only case

#### 本轮方法与版本

- 执行日期：2026-10-31；运行环境：macOS arm64，Node 24.22.2；远程配置模型：`deepseek-chat`。
- 共执行三次 `--engines rules,remote` 评估，每次远程实际运行49条，未跳过；规则引擎运行43条，按标签跳过6条llm-only对照。没有进行第四次评估。
- 临时观察器调用未修改的评估入口，并捕获同一次解释结果做逐例比对；不重复请求模型，不修改解释结果、校验器或指标计算。上方为最终评估脚本原始汇总。分组耗时是观察器测得的解释调用耗时，与上方包含少量统计开销的脚本耗时略有差异。
- 三次数据集字节完全一致。已有43条期望值未改；G044～G049由未读已有用例、提示词及实现的独立作者依据SPEC编写，在任何提示词修改前冻结。作者文件SHA-256：`ec32c39f6724521b1f1f5424e5be5c08dc55da8ed85c65ada28bb32068b74b4b`。
- 对照的文本、期望与结果未提供给提示词作者或审查者；总控在最终提示词冻结、三次评估完成后才展开对照结果。6条均为`reviewed:false`，结果仍待人工确认其标准答案。
- 最终版本只改提示词和派生追问上下文。中间版本进入评估后，独立静态审查发现“相邻同操作可合并”仍可能破坏set/remove顺序；最终版本删除跨更新合并指令。此修正来自SPEC审查，不来自对照结果。保留中间结果，不按最高得分选择版本。
- 所有比较均为单次样本，不代表远程模型稳定性验收，也不计入QA放行。没有保存Key、完整模型请求或登录信息。

| 运行 | 基线代码/提示词提交 | 提示词版本 |
| --- | --- | --- |
| 基线 v1 | `dc94d9103aac0d4bb65f639be77913df4bb3a007` | `v1` |
| 中间 v2 | `a73b6512d58200b84334e3fb67d78f0d2eda5908` | `v2` |
| 最终 v2 | `ffe119edbe1e3b756047bba921a395b55222577b` | `v2` |

#### 前后指标（远程全部49条）

| 运行 | 意图准确率 | 更新精确率 | 更新召回率 | unsure准确率 | 档案语义准确率 | 严格逐项通过 | 平均ms | 运行失败 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 基线 v1 | 46/49 (93.9%) | 41/46 (89.1%) | 41/66 (62.1%) | 48/49 (98.0%) | 24/49 (49.0%) | 22/49 (44.9%) | 1062.27 | 0 |
| 中间 v2 | 48/49 (98.0%) | 60/60 (100.0%) | 60/66 (90.9%) | 49/49 (100.0%) | 43/49 (87.8%) | 42/49 (85.7%) | 925.83 | 0 |
| 最终 v2 | 48/49 (98.0%) | 59/59 (100.0%) | 59/66 (89.4%) | 49/49 (100.0%) | 42/49 (85.7%) | 41/49 (83.7%) | 951.80 | 0 |

严格逐项通过要求意图、专业主题、更新集合（含op）、unsure及合并后的档案全部符合期望。运行失败指超时、不可用或输出结构异常；本轮三次均为0，原因集合均为空。内容不一致仍计入准确率分母，不能因为调用成功而算用例通过。

#### 分组比较（防止已有用例掩盖对照表现）

| 分组/运行 | 意图 | 更新精确率 | 更新召回率 | unsure | 档案语义 | 严格逐项 | 平均ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 已有43条 / 基线 v1 | 40/43 (93.0%) | 34/37 (91.9%) | 34/55 (61.8%) | 42/43 (97.7%) | 21/43 (48.8%) | 19/43 (44.2%) | 1041.32 |
| 已有43条 / 中间 v2 | 42/43 (97.7%) | 49/49 (100.0%) | 49/55 (89.1%) | 43/43 (100.0%) | 37/43 (86.0%) | 36/43 (83.7%) | 929.45 |
| 已有43条 / 最终 v2 | 42/43 (97.7%) | 49/49 (100.0%) | 49/55 (89.1%) | 43/43 (100.0%) | 37/43 (86.0%) | 36/43 (83.7%) | 941.84 |
| 独立6条 / 基线 v1 | 6/6 (100.0%) | 7/9 (77.8%) | 7/11 (63.6%) | 6/6 (100.0%) | 3/6 (50.0%) | 3/6 (50.0%) | 1211.28 |
| 独立6条 / 中间 v2 | 6/6 (100.0%) | 11/11 (100.0%) | 11/11 (100.0%) | 6/6 (100.0%) | 6/6 (100.0%) | 6/6 (100.0%) | 899 |
| 独立6条 / 最终 v2 | 6/6 (100.0%) | 10/10 (100.0%) | 10/11 (90.9%) | 6/6 (100.0%) | 5/6 (83.3%) | 5/6 (83.3%) | 1022.41 |

#### 基线已有用例：逐条不一致及分类

以下按可观察差异归类，不能据此断言模型内部原因。被取值校验丢弃的更新只记录了`Invalid slot value or operation`，不虚构未保存的原始格式。

| 用例 | 分类 | 基线差异 | 最终结果 |
| --- | --- | --- | --- |
| G001 | 相对时间 | 将明年映射为gt12m，需求约定为6to12m | 通过 |
| G006 | 值格式或操作 | goals更新未通过取值或操作校验，被丢弃 | 通过 |
| G008 | 值格式或操作 | goals更新未通过取值或操作校验，遗漏居留诉求 | 通过 |
| G010 | 诉求推导遗漏 | 专业签证问题遗漏居留诉求 | 不一致 |
| G012 | 相关意图边界 | 忽略注入指令和非法值后，领域相关内容被归为off_topic | 不一致 |
| G013 | 值格式或操作 | goals更新未通过取值或操作校验，遗漏税务诉求 | 通过 |
| G016 | 追问与不确定归属 | 多项追问时无指向的不知道被标到多个槽位 | 通过 |
| G020 | 家庭联动抽取 | 列出孩子年龄后遗漏可确定的人数 | 通过 |
| G021 | 家庭联动抽取 | 列出孩子年龄后遗漏可确定的人数 | 通过 |
| G023 | 明确否定信息遗漏 | 独自出行遗漏hasPartner=false | 通过 |
| G027 | 值格式与诉求op | 非法更新被丢弃，且明确替换被输出为删除旧诉求 | 通过 |
| G028 | 诉求推导遗漏 | 专业税额问题遗漏税务诉求 | 不一致 |
| G029 | 诉求推导遗漏 | 专业公司问题遗漏公司诉求 | 通过 |
| G030 | 专业意图边界 | 一般出国准备咨询被升级为专业资格判断 | 通过 |
| G031 | 值格式或操作 | goals更新未通过取值或操作校验，遗漏居留诉求 | 通过 |
| G034 | 诉求推导遗漏 | 公司业务信息遗漏相应公司诉求 | 不一致 |
| G035 | 诉求推导遗漏 | 学校偏好信息遗漏相应教育诉求 | 通过 |
| G036 | 诉求推导遗漏 | 医保信息遗漏相应医疗诉求 | 不一致 |
| G038 | 相对时间 | 将明年映射为gt12m，需求约定为6to12m | 通过 |
| G039 | 诉求推导遗漏 | 带国籍的专业签证问题遗漏居留诉求 | 不一致 |
| G040 | 诉求推导遗漏 | 带收入信息的专业税额问题遗漏税务诉求 | 通过 |
| G041 | 值格式或操作 | 带国籍的公司问题中goals更新被校验丢弃 | 通过 |
| G042 | 诉求推导遗漏 | 带国籍的专业签证问题遗漏居留诉求 | 不一致 |
| G043 | 专业意图边界与诉求遗漏 | 普通申请意愿被升级为专业判断，且遗漏居留诉求 | 通过 |

基线已有43条中24条不一致。最终已有集剩7条：G010、G028、G034、G036、G039、G042仍漏相应goals更新；G012仍把相关但含非法目的国的输入判为off_topic。最终没有非法槽位更新被丢弃。

#### 六条独立对照：逐条前后结果

| 用例 | 基线v1 | 中间v2 | 最终v2 | 基线差异/最终观察 |
| --- | --- | --- | --- | --- |
| G044 | 通过 | 通过 | 通过 | 通过追问上下文解析同本人国籍；三次均一致。 |
| G045 | 通过 | 通过 | 通过 | 居住国修正与明确居留身份共同保留；三次均一致。 |
| G046 | 不一致 | 通过 | 通过 | 基线goals更新因非法取值或op被丢弃；最终正确remove公司诉求。 |
| G047 | 不一致 | 通过 | 通过 | 基线用remove旧项加add教育代替明确set，档案修正语义不符；最终正确set教育。 |
| G048 | 通过 | 通过 | 通过 | 同行/孩子人数与年龄/相对时长均正确；三次均一致。 |
| G049 | 不一致 | 通过 | 不一致 | 基线遗漏税务诉求和自由职业收入来源；中间版本两者正确，最终保留税务诉求、专业意图和timeline不确定，但遗漏incomeSource=freelancer。 |

对照最终5/6，与中间版本6/6不同；未针对G049继续调参。6条样本较少且尚未人工审核，不能据此宣称普遍效果或稳定性。

#### 结论与未解决项

- 采用最终v2：已有集档案语义准确率由21/43提升到37/43；独立对照由3/6提升到5/6。全部49条语义准确率由24/49提升到42/49。
- 规则引擎在其43条适用用例上各指标仍为100%；6条对照依标签明确未执行规则评估。远程最终仍有8条内容不一致（7条已有用例、G049一条对照），未将这些遗漏修补到业务规则或校验逻辑。
- 本轮到此停止，不继续调整提示词、不修改标准答案。真实模型评估独立于开发测试及QA验收。
- 提交前已执行凭据残留检查：仅排除原始配置文件，其余指定目录匹配数为0；临时评估副本已删除。

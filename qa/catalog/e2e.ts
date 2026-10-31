import type { CaseDefinition } from './types.js';

export const cases: CaseDefinition[] = [
  {
    id: 'E2E-001', title: '登录、示例、快捷回答、修正与完整计划', type: 'e2e', priority: 'P0',
    requirements: ['H-01', 'H-02', 'H-03', 'H-04', 'H-05', 'H-08', 'H-09', 'SPEC-13.5'],
    assertions: '示例卡只填入不发送；中文示例不推断国籍、居住国或身份；快捷回答填入已明确值；修正配偶国籍后其他全部槽位保持原值；完整计划包含第一步、已知、未知、待确认、步骤原因、专业边界和免责声明；完成后输入框替换为提示条。',
    evidence: '全程录屏、trace、截图、真实 HTTP 快照',
  },
  {
    id: 'E2E-002', title: '刷新恢复完整对话、档案、过程与计划', type: 'e2e', priority: 'P0',
    requirements: ['H-04', 'H-06', 'SPEC-13.3'],
    assertions: '刷新前后每条消息内容、数量、连续序号、档案值和状态、过程记录文本一致；计划入口仍有效，刷新计划页后第一步和服务端完整计划内容完全一致。',
    evidence: '全程录屏、trace、persisted-snapshot 附件',
  },
  {
    id: 'E2E-003', title: '多标签消息同步与跨会话未读消除', type: 'e2e', priority: 'P1',
    requirements: ['SPEC-10.6', 'SPEC-13.4'],
    assertions: '同一会话两个页面逐条显示相同消息且每个 seq 仅一次；另一个会话回复后两个标签都有红点；聚焦打开该会话后两边红点均消失，服务端 lastReadSeq 等于 lastAssistantSeq。',
    evidence: '全程录屏、trace、两标签截图、已读快照',
  },
  {
    id: 'E2E-004', title: '停止、重试与运行中的补充', type: 'e2e', priority: 'P1',
    requirements: ['SPEC-7.2', 'SPEC-9.4', 'SPEC-13.5', 'B-07'],
    assertions: '理解阶段停止后 UI 显示已中断；重试生成新任务并指向原任务；回复中补充产生更新任务，初始目的国与补充国籍/孩子人数同时保存；最终只有一条助手回复，取消和被替代的任务没有回复。',
    evidence: '全程录屏、trace、任务和消息 HTTP 快照',
  },
  {
    id: 'E2E-005', title: '专业问题的条件与局限、无关内容的引导', type: 'e2e', priority: 'P0',
    requirements: ['H-05', 'H-08', 'SPEC-5.5', 'SPEC-15'],
    assertions: '签证问题显示持牌专业人士说明、已知国籍与待了解条件；无关问题显示出海计划引导，前后所有档案槽位和追问状态保持一致。',
    evidence: '全程录屏、trace、专业 notice 和档案快照',
  },
  {
    id: 'E2E-006', title: '坏 JSON 回退至规则并显示过程', type: 'e2e', priority: 'P1',
    requirements: ['H-09', 'SPEC-8.6', 'SPEC-13.5', 'B-11'],
    assertions: '本地假服务实际收到请求；远程返回坏 JSON 后助手 process 为 rules 且记录 remote/invalid_output；界面折叠摘要显示已回退到规则，展开显示来源、原因和耗时；用户明确国籍仍正确保存。',
    evidence: '全程录屏、trace、假服务请求、process 快照',
  },
  {
    id: 'E2E-007', title: '提前生成确认、未知项与通用国家清单', type: 'e2e', priority: 'P1',
    requirements: ['H-04', 'H-05', 'H-08', 'SPEC-13.5', 'B-18'],
    assertions: '智利显示通用资料提示；提前生成对话框列出缺项和结束后不能补充，取消不生成计划；确认后 generatedEarly=true、coverage=generic，未知居住国和专业边界可见，计划列表明确标注通用准备清单。',
    evidence: 'trace、录屏、计划 HTTP 快照',
  },
  {
    id: 'E2E-008', title: '快捷答案只更新所属槽位，过程显示快捷回答', type: 'e2e', priority: 'P1',
    requirements: ['X-01', 'X-13', 'SPEC-5.4'],
    assertions: '同时追问两个国籍时点本人国籍只更新本人，配偶和居住国保持 missing；该轮 engineUsed=null，过程记录显示快捷回答。',
    evidence: 'trace、档案前后快照、过程截图',
  },
  {
    id: 'E2E-009', title: '只有最新助手消息的快捷选项可操作', type: 'e2e', priority: 'P1',
    requirements: ['SPEC-13.5'],
    assertions: '产生新助手回复后上一条国籍快捷选项不可操作（禁用或不再呈现），最新回复的快捷选项仍可操作，防止历史选项覆盖当前档案。',
    evidence: 'trace、DOM 状态与截图',
  },
  {
    id: 'E2E-010', title: '发送失败重试复用标识且只建一个咨询', type: 'e2e', priority: 'P1',
    requirements: ['X-06', 'SPEC-13.5', 'SPEC-13.6', 'B-05'],
    assertions: '首次创建请求网络失败后显示重试；重试沿用原 clientMessageId；服务端只有一个会话、一条用户首消息，成功后发送中占位消失。',
    evidence: 'trace、真实请求标识和会话/消息快照',
  },
  {
    id: 'E2E-011', title: '路由保护、咨询不存在与退出登录', type: 'e2e', priority: 'P0',
    requirements: ['SPEC-13.1', 'SPEC-13.6', 'SPEC-19'],
    assertions: '未登录访问计划页跳转登录；不存在咨询显示明确错误；退出后 /me 返回 401；同名不同大小写重新登录能恢复原咨询。',
    evidence: 'trace、路由截图、HTTP 状态',
  },
  {
    id: 'E2E-012', title: '游标分页与同时新增消息不重不漏', type: 'e2e', priority: 'P1',
    requirements: ['SPEC-11.3', 'SPEC-12.3', 'SPEC-13.5'],
    assertions: '36 条历史初次只显示最新 30 条；转发并暂扣真实翻页响应时再新增 2 条，放行后 38 条逐条出现且各一次、DOM seq 顺序严格升序、没有更多页。',
    evidence: 'trace、真实分页响应、DOM 顺序',
  },
  {
    id: 'E2E-013', title: '初次同步的旧快照不覆盖较新任务和档案事件', type: 'e2e', priority: 'P1',
    requirements: ['X-09', 'SPEC-12.3', 'SPEC-13.3'],
    assertions: '当前连接 ready 到达后才请求详情；暂扣 activeTurn=null 的真实旧快照，期间新任务运行；旧响应放行后仍显示进行中任务；最终国籍为新值且旧档案不覆盖实时修正。',
    evidence: 'trace、真实 WS 帧及延迟 HTTP 响应',
  },
  {
    id: 'E2E-014', title: '超过一千事件后会话页完整重同步', type: 'e2e', priority: 'P1',
    requirements: ['X-09', 'SPEC-12.2', 'SPEC-13.3', 'B-21'],
    assertions: '断线期间通过公开偏好修改产生超过 1000 次版本增长；重连实际收到服务端 resync_required；连接恢复 live 后所有消息、档案修正与服务端快照一致。',
    evidence: 'trace、real-resync-frames、HTTP 快照',
  },
  {
    id: 'E2E-015', title: '整体重同步恢复我的计划列表', type: 'e2e', priority: 'P1',
    requirements: ['X-09', 'SPEC-13.3'],
    assertions: '停留我的计划页断线并真实累积超过 1000 事件，期间新增计划；重连接收 resync_required 后旧计划和新计划均出现且各一次，通用清单标注保留。',
    evidence: 'trace、真实 WS 帧、计划列表截图',
  },
  {
    id: 'E2E-016', title: '计划详情页首次连接和整体重同步内容完整', type: 'e2e', priority: 'P1',
    requirements: ['X-09', 'SPEC-13.3'],
    assertions: '直接打开计划详情可读第一步；真实超过 1000 事件触发重同步后第一步不变，已知、未知、边界、免责声明和每个步骤仍齐全。',
    evidence: 'trace、真实 WS 帧、计划详情截图',
  },
  {
    id: 'E2E-017', title: '断线期间其他标签切换身份后不混用数据', type: 'e2e', priority: 'P0',
    requirements: ['X-11', 'SPEC-13.3', 'SPEC-19'],
    assertions: 'A 标签断线，B 标签退出并登录另一用户；A 重连接到新 ready.userId 后旧用户会话消失，新用户会话和日本/智利档案可见，旧资源访问返回 404。',
    evidence: 'trace、真实身份绑定 WS 帧、两个标签截图',
  },
  {
    id: 'E2E-018', title: '重同步前迟到的旧翻页响应不污染数据和游标', type: 'e2e', priority: 'P1',
    requirements: ['X-12', 'SPEC-13.3'],
    assertions: '暂扣真实旧翻页响应后通过真实事件积压触发整体重同步；放行旧响应并处理新回复后最早页仍未混入；重新翻页最终全部 40 条逐条恰好一次且游标结束。',
    evidence: 'trace、真实延迟响应、真实 WS 重同步帧、DOM 消息断言',
  },
  {
    id: 'E2E-019', title: '空白、超长、消息满额与咨询上限提示', type: 'e2e', priority: 'P1',
    requirements: ['X-08', 'SPEC-13.5', 'B-01', 'B-02', 'B-03', 'B-04'],
    assertions: '空白和超过配置字数时不能发送；消息上限 4 时两轮最终恰好 4 条，输入框替换成满额提示；超过 1 个咨询时明确提示且服务端数量仍为 1。',
    evidence: 'trace、界面状态、消息和会话快照',
  },
  {
    id: 'E2E-020', title: '引擎偏好保存且下一轮使用选定规则引擎', type: 'e2e', priority: 'P1',
    requirements: ['H-09', 'SPEC-8.5', 'SPEC-13.5'],
    assertions: '无 Key 时远程和本地选项禁用；选择 rules 后服务端偏好为 rules；下一轮 process 为 rules 且无回退；刷新后选择仍保存。',
    evidence: 'trace、选择器状态、HTTP 和 process 快照',
  },
];

import type { CaseDefinition } from './types.js';

export const cases: CaseDefinition[] = [
  { id: 'WS-001', title: '缺少 Cookie 的升级被拒绝', type: 'ws', priority: 'P0', requirements: ['SPEC-12.1', 'SPEC-19'], assertions: '允许的 Origin、无令牌时握手 HTTP 401，不能建立连接。', evidence: '握手 HTTP 状态' },
  { id: 'WS-002', title: '无效令牌的升级被拒绝', type: 'ws', priority: 'P0', requirements: ['SPEC-12.1', 'SPEC-19'], assertions: '伪造 nc_token 时握手 HTTP 401。', evidence: '握手 HTTP 状态' },
  { id: 'WS-003', title: '跨站和缺少 Origin 被拒绝', type: 'ws', priority: 'P0', requirements: ['SPEC-12.1', 'SPEC-19', 'B-23'], assertions: '有效令牌配非法 Origin 或无 Origin 时均为 HTTP 403。', evidence: '两次握手 HTTP 状态' },
  { id: 'WS-004', title: '首次连接 ready 后获取完整快照', type: 'ws', priority: 'P0', requirements: ['SPEC-12.2', 'X-09', 'H-06'], assertions: 'null 游标先返回带正确 userId 的 ready，不补发旧事件；随后 REST 对话、消息、档案与计划均完整。', evidence: '协议消息及 REST 快照' },
  { id: 'WS-005', title: '业务事件携带已持久化完整实体', type: 'ws', priority: 'P0', requirements: ['SPEC-12.3', 'SPEC-7.2'], assertions: '创建后收到会话、用户与助手消息、任务完成事件；消息 ID/seq 与 REST 一致，会话含档案，任务各阶段 version 严格递增，事件 ID 无重复且递增。', evidence: '事件流、REST 对照' },
  { id: 'WS-006', title: '断线期间事件按序完整补发', type: 'ws', priority: 'P0', requirements: ['SPEC-12.2', 'B-21'], assertions: '断线后产生的事件与同时在线见证连接逐个一致；补发 ID 大于游标并升序，ready 之后新事件仍收到。', evidence: '见证连接与重连连接的事件 ID 列表' },
  { id: 'WS-007', title: '正好一千条待补发事件不触发全量同步', type: 'ws', priority: 'P1', requirements: ['SPEC-12.2'], assertions: '通过一千次公开偏好修改产生恰好一千条事件，重连全部补发且没有 resync_required。', evidence: '公开修改结果、两条连接的事件流' },
  { id: 'WS-008', title: '超过一千条事件触发全量同步', type: 'ws', priority: 'P0', requirements: ['SPEC-12.2', 'X-09', 'B-21'], assertions: '公开操作实际产生一千零一条事件；重连先 resync_required 后 ready，不逐条补发旧事件；REST 恢复完整会话和计划。', evidence: '公开操作计数、协议顺序、REST 快照' },
  { id: 'WS-009', title: '不同用户之间不广播或补发事件', type: 'ws', priority: 'P0', requirements: ['SPEC-12.2', 'SPEC-19'], assertions: '用户 B 完成创建与回复后，用户 A 实时流与从 0 补发均无 B 的会话/消息/任务；检查包含完成信号及有界负向观察。', evidence: '双用户事件流及 REST 完成状态' },
  { id: 'WS-010', title: '退出关闭该令牌的全部连接', type: 'ws', priority: 'P0', requirements: ['SPEC-12.1', 'SPEC-11.3', 'X-07'], assertions: '同一令牌的两个连接均以 4401 关闭，旧令牌再握手 401；同用户其他令牌仍可获取新事件，旧连接不再收到事件。', evidence: '关闭码、握手状态、连接事件计数' },
  { id: 'WS-011', title: '令牌上限淘汰最早令牌并关闭连接', type: 'ws', priority: 'P0', requirements: ['SPEC-11.3', 'SPEC-12.1'], assertions: '上限为 2 时第三次登录关闭第一个令牌连接（4401），第二个仍存活；最早令牌握手 401，新令牌能接收事件。', evidence: '三次登录、关闭码及事件流' },
  { id: 'WS-012', title: '计划与已读事件和 REST 一致', type: 'ws', priority: 'P1', requirements: ['SPEC-12.3', 'SPEC-10.6'], assertions: 'plan.created 对应持久化计划，conversation.upserted 标 completed/planId；read_state.updated 为相同会话和序号，REST 同值。', evidence: '计划和已读事件、REST 对照' },
  { id: 'WS-013', title: '并发发送的实时序号与存储一致', type: 'ws', priority: 'P0', requirements: ['SPEC-12.3', 'SPEC-11.3', 'B-06'], assertions: '两条同时发送的用户消息均存在且 seq 唯一连续，事件 ID/消息 seq 与 REST 一致，无消息丢失或重复。', evidence: '并发 HTTP 结果、事件与消息页' },
  { id: 'WS-014', title: '未来游标不补发旧事件但继续接收实时变化', type: 'ws', priority: 'P1', requirements: ['SPEC-12.2'], assertions: '大于当前最大 ID 的游标收到 ready 且无历史补发，之后公开创建仍收到事件。', evidence: 'ready 及后续 message.created' },
  { id: 'WS-015', title: '超过四 KB 的客户端帧以 1009 关闭', type: 'ws', priority: 'P1', requirements: ['SPEC-12.1'], assertions: '发送超过 4096 字节的客户端消息后连接以关闭码 1009 关闭；会话 REST 状态保持不变。', evidence: '帧字节数、1009 关闭事件、前后快照' },
  { id: 'WS-016', title: '服务端 ping 与正常 pong 保活', type: 'ws', priority: 'P1', requirements: ['SPEC-12.1'], assertions: '接收到连续两次服务端 ping，间隔约 25 秒；自动 pong 的连接保持可接收业务事件。', evidence: 'ping 时间戳与业务事件' },
  { id: 'WS-017', title: '连续未 pong 的连接被关闭', type: 'ws', priority: 'P1', requirements: ['SPEC-12.1'], assertions: '禁用自动 pong 后接收到至少两次 ping，并在随后心跳检测中关闭连接。', evidence: 'ping 时间戳和关闭事件' },
  { id: 'WS-018', title: '显式允许列表与生产同源均能连接', type: 'ws', priority: 'P1', requirements: ['SPEC-12.1', 'SPEC-16'], assertions: 'WEB_ORIGIN 中的两个来源以及服务自身同源均能升级并返回正确 ready.userId。', evidence: '三个来源的 ready 消息' },
  { id: 'WS-019', title: '损坏 JSON 和结构非法的客户端消息被忽略', type: 'ws', priority: 'P1', requirements: ['SPEC-17'], assertions: '损坏 JSON、缺字段、错误 type、游标类型或范围非法、错误顶层类型均被忽略；每条非法帧之后以合法 resume/ready 确认连接继续工作，未关闭、无异常业务事件，会话与消息快照不变。', evidence: '15 种非法帧的独立步骤、后续 ready、业务事件列表及前后 REST 快照' },
];

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cases } from '../catalog/index.js';
import { requirements } from '../catalog/requirements.js';
import type { CaseDefinition } from '../catalog/types.js';

export const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
export function linkedCases(id: string): CaseDefinition[] {
  const requirement = requirements.find(row => row.id === id);
  return cases.filter(row => row.requirements.includes(id) || requirement?.extraCases?.includes(row.id));
}
export const preparationResult = (id: string): string => cases.find(row => row.id === id)?.notApplicable ? '不适用' : '未执行';
export function matrix(result: (id: string) => string = preparationResult): string {
  const lines = ['| 需求编号 | 需求摘要 | 用例编号 | 类型 | 断言内容 | 证据 | 结果 |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const requirement of requirements) {
    const linked = linkedCases(requirement.id);
    if (!linked.length) throw new Error(`Uncovered requirement: ${requirement.id}`);
    for (const row of linked) lines.push(`| ${requirement.id} | ${cell(requirement.text)} | ${row.id} | ${row.type} | ${cell(row.assertions)} | ${cell(row.evidence)} | ${result(row.id)} |`);
  }
  return lines.join('\n');
}
export async function writeDocuments(): Promise<void> {
  const counts = ['api', 'e2e', 'ws', 'env', 'manual'].map(type => `${type}: ${cases.filter(row => row.type === type).length}`).join('；');
  const lines = [
    '# Nomad Concierge 黑盒测试计划', '', '本文件保留准备阶段的设计与状态基线；当前候选的实际执行结果见 [执行报告](reports/summary.md)。', '', '阶段：准备，等待候选交接。所有适用项均未执行；MAN-007 按 Q-02 裁定为不适用。编译与发现检查不代表产品验证。契约：SPEC v1.3 及 2026-10-31 的 Q-01～Q-03 裁定。', '',
    `用例清单：${counts}。每个编号对应一个 Playwright 测试，manual 对应可登记的人工检查。参数化子断言不重复计数。`, '',
    '## 范围与执行前置', '',
    '- 只依据需求、SPEC、共享 DTO/schema/测试 ID 和 README 操作部分；期望值不调用产品业务函数。',
    '- 候选由集成负责人组装并声明 WP6 已完成；记录产品、QA、候选提交及 SPEC/README/锁文件版本。未提供候选时执行入口拒绝启动。',
    '- 每用例使用独占 API 进程、动态端口、临时数据库和本地假模型；浏览器使用完整版 Chromium。所有 E2E 开启 video 和 trace，核心六场景为 E2E-001 至 E2E-006。',
    '- 完整入口：业务套件三轮，环境矩阵一轮。macOS Node 22.13.0/24、干净 Linux、Docker 串行检查。只按最终 README 转录的命令配方运行；未提供配方或资源记受阻。',
    '- 真实模型和内部提交钩子不纳入黑盒自动化；内部状态转换全表、忽略中断后的迟到返回及事务回滚移交开发测试证据。',
    '- 通过、失败、受阻、未执行、跳过、不稳定分别记录；不适用项须有明确裁定和原因，单独列出，不计通过率分母或通过数。适用人工项须同候选登记。',
    '', '## 用例', '', '| 编号 | 标题 | 优先级 | 类型 | 需求来源 | 断言内容 | 状态 |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...cases.map(row => `| ${row.id} | ${cell(row.title)} | ${row.priority} | ${row.type} | ${row.requirements.join(', ')} | ${cell(row.assertions)} | ${preparationResult(row.id)} |`), '',
    '## 质量边界', '', '负向断言使用任务终态、ready 或明确观察窗口；不会以立即检查空数组证明没有副作用。时序依赖等待公开状态或可控假服务，不使用固定睡眠等待业务完成。页面同步用例转发真实 HTTP/WS，只控制释放时机；超过 1000 条事件由公开操作真实生成。', '',
    '发布判定：必测项实际通过、业务连续三轮、环境一轮且无 P0/P1 缺陷；P2/P3 由负责人登记处理结论。准备阶段不作发布判定。', '',
  ];
  await writeFile(resolve('test-plan.md'), lines.join('\n'));
  await writeFile(resolve('traceability.md'), `# Nomad Concierge 需求追踪矩阵\n\n本文件保留准备阶段的设计覆盖基线；当前候选的逐项执行结果见 [执行报告](reports/summary.md) 中的完整追踪矩阵。\n\n状态：准备，适用项全部未执行；MAN-007 按 Q-02 裁定为不适用（交付不提供 HTTPS 入口且不信任代理头，Secure 四种组合由开发单元测试覆盖）。H 为九项硬性要求；F 为二十四组功能；X 为十六项跨模块规则；S 为四组提交要求；B 为 SPEC 第 18 节二十五行边界。共 ${requirements.length} 条需求，均有具体断言或人工步骤。关联数量表示设计覆盖，不表示验证通过。B-24/B-25 是内部故障的开发证据移交，不计为 QA 黑盒自动化已验证。\n\n${matrix()}\n`);
}
if (process.argv[1]?.endsWith('/documents.js')) await writeDocuments();

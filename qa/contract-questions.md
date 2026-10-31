# 契约问题与交接依赖

状态：准备；以下内容不构成产品缺陷，也不构成通过结果。

| 编号 | 问题 | 依据及影响 | 当前处理 |
| --- | --- | --- | --- |
| Q-01 | POST read 的 seq 大于 last_seq 时，返回 200 并夹到上限，还是 422？ | SPEC 9.4 只要求 seq 不超过 last_seq；11.3 列 422，但未指定这个分支。 | API-014 先验证正常/倒退读序号；超界分支在裁定前记受阻。裁定后用 QA_READ_OVERFLOW_POLICY=clamp 或 reject，不静默修改期望。 |
| Q-02 | production 的 HTTPS Cookie Secure 通过什么本地入口验证？是否信任代理协议头？ | SPEC 11.3 要求 HTTPS 加 Secure，运行契约只给 HTTP 入口，未给本地 TLS 或代理信任配置。 | MAN-007 移交本地 HTTPS 入口，明确前置后执行；不擅自假设 X-Forwarded-Proto 被信任。 |
| Q-03 | 合法 JSON 但 resume 结构不合法时应忽略还是关闭？超大帧关闭码是否固定？ | SPEC 17 明确坏 JSON 忽略；SPEC 12.1 指定 4 KB 上限但未指定关闭码。 | WS-019 验证坏 JSON 忽略；WS-015 只验证超大帧断开和数据不变。未承诺的结构分支不编造断言。 |

SIGTERM 的 attempt 按 SPEC 7.2（running→queued 增加一次）断言；同一用例还必须观察停机时 queued 事件和 1012，再重启验证同任务完成，不能用崩溃恢复冒充优雅停机。

待交接：已组装候选及产品/QA SHA、WP6 完成声明、最终 README 操作部分及 compose、Node 22.13.0/24、Docker/离线缓存、最终提交包。当前不对未交付部分报产品缺陷。

# workbuddy-to-dsh 桥接插件快照 · 2026-11-08

> **状态**：本次同步（20:38，宿主明确发话「你先备份一版本到 github 上面」）= **第 1~6 刀当前生效版**，
> 由本机 Git 经仓库级 SSH Deploy Key 推送到远端 `main`，远端与本地 HEAD SHA 一致、逐文件 blob 校验通过。
> 前三次快照留在 git 历史里可一键回退：`4ebdc9a` 第 4 刀（修复前基线）、`5cd5e32` 第 1+2+3 刀、`db90881` 第 1 刀之前。
> 本机 GitHub 集成只有读权限，故用部署密钥；本地另有 ZIP 双保险（该 ZIP 仍是 17:30 第 4 刀基线，本次未重打）。
> ⛔ 本快照不含凭据、令牌、日志、会话数据、工作台规则文件；说明文档不含绝对路径或会话标识。
> 插件源码自带的通用 Windows 路径示例与自测夹具字符串属原文件内容、非本机配置（上一版快照已含，非本次新增）。

## 版本标识

**第 1 刀（剥离 ACP 压缩内务模板）+ 第 2 刀（下沉规则摘要化）+ 第 3 刀（结构化历史清洗）+ 第 4 刀（桥本体 sink 默认首发）+ 第 5 刀（净版逐字下沉）+ 第 6 刀（首发链恢复 A 类轻链安全命中）** 全部落地版。
宿主 19:29 重启后，当前 active 桥（web profile）真机生效；desktop 链同版补丁、基线不同，未整文件覆盖。

真机读数（当前 active 链，最后一次启动横幅之后 47 次上游请求，截至备份时）：

- 47/47 全部 `sink-first`（首发即下沉，不再先撞 11128 再降级）。
- 其中 12 次 `system-rules-sink:a-light`：`keeps 0 chars`、`boundary=0 plain=0 light=1`，唤醒轮只发中性 system + 宿主那一句。
- 其余 35 次 `system-rules-sink`：`plain=1 light=0`，逐字下沉 15479 字规则、`history -2 msg(s) / -7458 chars`、`boundary=0`，真业务单没有被误判成轻链。
- `upstream 11128` 降级 **0 次**；兜底耗尽 0、上游断流 0、429 0、超时 0、备用模型 11128 0。

⚠ **通道层已解决，≠ 宣布办事已治好**：19:53 的第一张真业务单（GUI 场景）22.9 分钟闭环，
16 段 / 140749 字推理 / 22 个工具 / 695 字回复，产物确实落盘且语法检查通过；
但 `compress` 直到开局 +22.6 分才触发。压缩后桥侧消息数 141 → 47、20 秒内闭环 ⇒ 压缩有效，**残留问题是触发太晚**。

## 内容

`web/` 与 `desktop/` 各 5 个文件（两条 profile 链），共 10 个桥文件 + 2 份说明：

| 文件 | 说明 | md5 |
|---|---|---|
| `bridge/system-sink.mjs` | 第 1+2+3+5 刀落地版，`plain` 模式与 15 条第 5 刀自测（两 profile 逐字相同，第 6 刀未改此文件） | `0b22a9ce291f71c0ca8ba8c10c389da1` |
| `bridge/system-sink.mjs.bak-20261108-0950` | 09:50 改前原件（保留，一键回到最原始行为，本次未改） | `3e2b3cb090b6801bf1bd91f80a0ed03f` |
| `bridge/workbuddy-bridge.mjs` | 第 4+5+6 刀桥本体：`WORKBUDDY_SINK_FIRST` / `WORKBUDDY_SINK_PLAIN` / `WORKBUDDY_SINK_FIRST_A_LIGHT`、`firstSinkCandidates()` 认 `a-light`、候选日志带 `plain` / `light` | web `6d61eeb3299ff5372fc52525116bbe3b` / desktop `224cff1ef60056f25c11a24256a5755f` |
| `dsh-plugin/lib/index.js` | `BRIDGE_ENV_PASSTHROUGH` 已补登本版 8 个下沉开关（两 profile 相同） | `38db2ff1f05710f59201daf3ab726ac6` |
| `.env.example` | 8 个开关说明与真机依据（两 profile 相同） | `f60d040a64519a861f70b35c17b48093` |

`dsh-plugin/lib/index.js` 与 `.env.example` 是第 3 刀时新增纳入的：少了它们，`=0` 回退开关传不进桥进程，备份就不完整。
两条链的桥主脚本仍是不同基线（desktop 原为 v2，web 为纯 v3），补丁分别落地、⛔ 不做整文件覆盖。

## 六刀要点

上游 11128 降级会把整段 system 换成中性句并丢掉原规则，规则与宿主指令同层 ⇒ 模型逐条裁决、写数万字推理。

- **A 类轻链**：宿主给死答案时出站只发中性 system + 那一句；只在本轮最后一段连续 user 内判定，遇 assistant / tool 立即停止，绝不跨轮翻旧账（12:09 跨轮误判已修）。
- **第 1 刀**：结构化剥掉 system 里的 ACP 压缩内务模板块。
- **第 2 刀**：逐字搬运换成固定短抬头 + 核心硬规摘录 + 按需 read 指针，总长硬上限 1200 字。默认首发 `plain` 模式下**不启用**，`WORKBUDDY_SINK_PLAIN=0` 可回到它。
- **第 3 刀**：剥掉命中固定开头锚点的引擎内务 user 消息，只删 user、不动 tool 配对；默认仍开，但首发 `plain` 模式**不再追加旧任务边界注记**。
- **第 4 刀（桥本体）**：把 sink 从「11128 之后的降级候选」提升为**默认首发形态**；首包正常取限流许可、首发不写 `attempt.fallback`，只有真撞 11128 才写降级账本。
- **第 5 刀（净版逐字下沉）**：真机证明裁决式抬头 / 边界注记净负（推理里逐字命中「宿主最近一句指令」13 次、「历史边界」11 次、「不续跑」9 次，20 个工具 0 次 `compress`）。改为 `plain=true` 时规则消息 = 剥完 ACP 内务后的 `rules` 原文，**零抬头、零后缀、零边界注记、不摘要、不禁 `compress`**。
- **第 6 刀**：19:02 两个唤醒轮因首发禁轻链 + 撤注记后翻出旧催办令，花 33413 / 59969 字裁决并调 `compress`，耗时 214.6s / 262s。故首发链恢复 A 类轻链安全命中；`findIndex` 必须同时认 `system-rules-sink` 与 `system-rules-sink:a-light`，否则退回撞 11128 的老路。

⛔ 代价：规则以 user 身份进模型，优先级低于 system；可用 `WORKBUDDY_SINK_FIRST=0` 回退。
⛔ 推理档恒 `high`，不靠降档提速；不改模型、不动 `maxTokens`、不切原生 provider、不改引擎本体。
⛔ 磁盘改 ≠ 生效：桥是常驻 ESM 进程，必须重启桥才加载；只重启客户端不换桥。

## 开关

| 环境变量 | 默认 | `=0` 效果 |
|---|---|---|
| `WORKBUDDY_SYSTEM_SINK` | 开 | 整体回到原版降级链（会重新丢掉全部规则） |
| `WORKBUDDY_SINK_FIRST` | 开 | 回到「首包撞 11128 再降级」的改前行为 |
| `WORKBUDDY_SINK_PLAIN` | 开 | 首发回到第 2/3 刀摘要 + 抬头 + 边界注记 |
| `WORKBUDDY_SINK_FIRST_A_LIGHT` | 开 | 首发一律禁 A 类轻链，回到第 5 刀行为 |
| `WORKBUDDY_A_LIGHT` | 开 | 回到完整下沉 |
| `WORKBUDDY_STRIP_HOUSEKEEPING` | 开 | 第 1 刀单项回退 |
| `WORKBUDDY_SINK_SUMMARY` | 开 | 第 2 刀逐字全量回退（仅非 plain 路径生效） |
| `WORKBUDDY_HISTORY_CLEAN` | 开 | 第 3 刀完全回退 |

## 自测与还原

- 两 profile 共 6 个 JS 文件 `node --check` 全过；`node bridge/system-sink.mjs --自测` → **134/134 全绿**（两 profile 相同；第 5 刀新增 15 条）。
- 第 4 刀历史验收存档：静态断言 `34/34`、变异 M1~M6 全部打中预期红项、装回原件全绿、隔离执行首发链行为验证 `24/24`、`collectBridgeExtraEnv` 真跑透传成功。
- 第 6 刀真机验收：19:29 重启后横幅起 12/12 唤醒轮为 `a-light`，后续 35 次真业务单请求为 `plain=1 light=0`，`11128 / exhausted / interrupted / 429 / timeout` 全 0。
- ⚠ 改文件后**必须重启桥**（ESM 常驻进程不热更新），否则磁盘改 ≠ 生效。
- 完整回退：取 git 历史 `4ebdc9a`（第 4 刀）、`5cd5e32`（第 3 刀）或 `db90881`（第 1 刀之前）；只回到最原始行为：把对应 profile 的 `.bak-20261108-0950` 改回 `system-sink.mjs`。

## 边界与已知问题

- **第 7 刀暂缓**：先派第二张同类同难度真业务单分离变量。触发条件写死 —— 若仍是 ~23 分钟 + 前几段复述裁决占 >70% + `compress` 晚到 20 分以后，才动，且只做「在 `cleanHistoryMessages()` 里结构化删除已了结的旧派单 / 旧催办 / 旧回执」一刀，不配套新增判据、项目档或落盘机制。
- 不做：`compress` 早触发的引擎黑盒修复、改模型、降 `reasoningEffort`、改 `maxTokens`、原生 provider 分流。
- 引擎发给桥的 payload 与会话事件流不是同一份：桥侧历史清洗只剥到 2 条 / 约 7458 字，长历史主体仍在。
- `normalizePayload` 每轮仍改写 1 条 audit-template system 消息，本版未改。
- 那份 17:30 的本地 ZIP 双保险仍是第 4 刀基线，**不等于本快照**，还原时以本仓库 `main` 为准。
- 插件来源 `github:Ianzhyh/workbuddy-to-dsh`（MIT）；本快照仅含本地修改过的桥文件，不含依赖与运行时数据。

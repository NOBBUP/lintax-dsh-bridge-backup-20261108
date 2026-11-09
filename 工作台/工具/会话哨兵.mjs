#!/usr/bin/env node
/**
 * 会话哨兵.mjs —— 2026-11-01 加（宿主："自动化任务应当在会话**思考时**推送，空闲不推"）
 *
 * 为什么要它：
 *   之前的催办是**固定闹钟**（每 10 分钟），不管对方在不在干活都推一次 ——
 *   空闲时推 = 纯噪音；更糟的是：会话正忙着跑，催办却排在它干完之后才到（queue 模式），
 *   等于"活干完了才被催去干活"。
 *
 *   正解：**盯着会话状态推**。引擎 `session/list` 每条会话自带：
 *     · `running`         —— 此刻是否正在思考/执行（这是判据，不是时间）
 *     · `projections.values.contextPressure` —— 上下文压力（projectedTokens / contextWindow）
 *   于是：
 *     · `running = false`（空闲） ⇒ **什么都不推**，直接跳过
 *     · `running = true` 且未交回执 ⇒ 才 `steer` 推一次（插到当前步骤，不排队）
 *     · 上下文压力超阈值 ⇒ 提醒该交接了（这是"会话太长就交接"的触发点）
 *
 * ── 2026-11-01 二改（宿主：「十分钟催促也修复下」「审批卡住要告警」）──
 *   事故实证：客户系统运维 19:33:20 调 edit 写 L2场景私有 记忆 → 弹提权审批 →
 *   **没人看见，晾了 78 分 10 秒**（19:33:20→20:51:30 才 allowed-once）。
 *   整轮 1h34m 里 83% 在等审批；而三条老判据（压力 31% / 非空闲 / 5 轮）一条都没命中。
 *
 *   ⇒ 补两条**按时间**的硬判据。但注意（2026-11-02 宿主纠正）：
 *     **「10分钟催促」的目的是催进度，不是查它死没死。** 所以这两条主次必须分清：
 *     ① **催促进度（主线）**：running 且 (now - 本步开始) ≥ --思考 600 秒
 *        ⇒ steer 推「别往下铺了，先交结果」，并**逐级加码**：
 *           第1档 催快（砍附加功能，下一条消息就要能看的结果）
 *           第2档 加压（只做最小可用版本，先落盘已完成部分）
 *           第3档 收口（停止推进，写 §〇，评估换会话/换思路）
 *        每跨过一个 --思考 周期才升一档，同一档不重复推。
 *     ② **疑似卡死（副线）**：running，**已经催过**，且**观察窗口内 steps/toolMs/llmMs
 *        三个累计量一个都没涨** ⇒ 才推「催了还没动静，可能是审批挂着 / agent 掉了」。
 *        ★ 2026-11-02 三期移植·一期改：判据从 `updatedAt` 换成**累计量增量**。
 *          原因（实测）：updatedAt **不是心跳** —— 同一会话 steps 从 431 涨到 434 的
 *          整整 12 分钟里，updatedAt 冻在 16:06:26 一动不动。拿它判活 ⇒ 真在干活也报卡死。
 *        ⛔ 副线绝不能抢在催促前面 —— 否则 10 分钟一到人家先收到一句"你是不是挂了"。
 *
 * 用法：
 *   node 工具\会话哨兵.mjs --看              # 看一次盘，只报告，不推
 *   node 工具\会话哨兵.mjs --盯              # 监看模式（默认 180 秒一轮）
 *   node 工具\会话哨兵.mjs --盯 --间隔 300
 *   node 工具\会话哨兵.mjs --压力 70         # 上下文压力告警阈值（%，默认 70）
 *   node 工具\会话哨兵.mjs --思考 600        # 催促进度的起催阈值（秒，默认 600 = 10 分钟，之后每 10 分钟升一档）
 *   node 工具\会话哨兵.mjs --卡死 600        # 催过之后多少秒「steps/toolMs/llmMs 三个累计量一个都没涨」算卡死（默认 600）
 *   node 工具\会话哨兵.mjs --干跑            # 判据照跑、消息照打印，但不真发、不写状态（自测用）
 *
 * ⛔ 不推的情况：会话空闲时只推压缩/收尾/换会话 / 干活中只催进度 / 会话是自己 / 已归档会话
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// ★★ 2026-11-08：判活只准用这一份实现（`EPERM ⇒ 活着` 的误判就死在这份文件里）
import { pidAlive } from './_进程存活.mjs';

const here = path.dirname(path.resolve(process.argv[1] || fileURLToPath(import.meta.url)));
const ROOT = (() => {
  if (process.env.DSH_WORKBENCH_ROOT) return process.env.DSH_WORKBENCH_ROOT;
  const looksLikeRoot = (d) => {
    // ★ 2026-11-03 11:30：必须同时有 **外壳\\main.js** —— 这是 Electron 外壳真身，唯一能区分
    //   真工作台根 与 D:\\Lintax数据（那边是副本，有 外壳\\scenarios / 工具 / 引擎\\.dsh，但**没有 main.js**）。
    //   实测事故：绝对路径调用时 looksLikeRoot 命中 D:\\Lintax数据 ⇒ 找不到 server.log ⇒ 拿不到 cookie ⇒
    //   工具静默按"引擎没跑"退出，人还以为通道坏了。
    try {
      return fs.existsSync(path.join(d, '外壳', 'main.js'))
        && fs.existsSync(path.join(d, '外壳', 'scenarios'))
        && fs.existsSync(path.join(d, '引擎', '.dsh'))
        && fs.existsSync(path.join(d, '工具'));
    } catch { return false; }
  };
  // ① 从脚本位置往上找（最多 5 层）—— 正常装在 <root>\工具\ 下，第一轮就命中
  let d = here;
  for (let i = 0; i < 5; i++) {
    if (looksLikeRoot(d)) return d;
    const up = path.resolve(d, '..');
    if (up === d) break;
    d = up;
  }
  // ② 已知真根候选 —— 工具\ 是 junction 指向 D:\Lintax数据\工具，
  //    用 D 盘绝对路径调用时向上只能走到 D:\Lintax数据（副本）和 D:\，**走不到 C 盘真根**。
  //    这里直接试死几个已知位置；仍然要求它们真的"像根"（有 main.js），⛔ 不靠猜。
  for (const cand of [
    'C:\\Users\\a1872\\Documents\\deepseek-harness\\default-workspace\\Lintax工作台',
    path.resolve(here, '..', '..'),          // 万一工具目录不在根下
  ]) {
    if (looksLikeRoot(cand)) return cand;
  }
  // ③ 退回脚本上级（老行为，至少不会崩）
  return path.resolve(here, '..');
})();
const SCEN = path.join(ROOT, '外壳', 'scenarios');
// 共享层（写 _待办.md 用）。注意：**不要**用 `引擎\.dsh\场景记忆\_共享记忆`
//   —— 那是外来包的旧约定，本机共享层在 L1共享层（宪法 §3 单一真源）。
const SHARED_MEM = path.join(ROOT, 'L1共享层', '_共享记忆');
// ★ 2026-11-03 10:30：项目信息主题文档根（宪法 §10）。与 项目本地化体检.mjs 同一口径。
const PROJ_BASE = path.join('D:', 'Lintax数据', '项目');
const DSH_PORT = String(process.env.DSH_PORT || '3083');
const SELF_ID = String(process.env.DSH_SESSION_ID || '').trim();

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const LOOK = has('--看');
const WATCH = has('--盯');
const DRYRUN = has('--干跑');            // 判据照跑、消息照打印，但不真发（自测用）
const INTERVAL = Math.max(60, Number(val('--间隔', 180)));    // 轮询间隔：3 分钟一轮（原来是 60s，宿主嫌太吵）
const THINK_SEC = Math.max(60, Number(val('--思考', 600)));   // 思考超时：默认 10 分钟
const STALL_SEC = Math.max(60, Number(val('--卡死', 600)));    // 无事件卡死：默认 10 分钟

// ══════════════════════════════════════════════════════════════════════════
// ★★ 2026-11-09 01:0x 宿主定稿（t78 55.2 分实测后）：**收口令取代三档催办** ★★
//   t78 三条自动催办（12/21/30 分）一次都没让它停，每条后面反而跟 1~3 万字裁决段；
//   宿主 23:12:52 一句「还没结束吗？尽快结束」→ 23:14:55 闭环，2 分 03 秒。
//   ⇒ 结论：缺的不是「再催一次」，是「明确的停机信号」。改由外部执行层代发。
//   ⛔ 绝不写成给模型的 system 提示（v1 抬头逐字引用 13 次 / turn21 净负，第 5 刀才止住）。
//   条件取先到者：① 收工自检全绿且已过最短窗口 ② 跑满 20 分钟硬兜底（绿没绿都停）。
//   一轮只投一次；`--用旧催办` 可整段回退到 10/20/30 分三档（真机 A/B 用）。
// ══════════════════════════════════════════════════════════════════════════
const USE_OLD_NUDGE = has('--用旧催办');
const STOP_MAX_SEC = Math.max(60, Number(val('--收口上限', 1200)));  // 20 分钟硬上限：宿主 01:04 定死「20 分钟直接确定」
const STOP_MIN_SEC = Math.max(0, Number(val('--收口最短', 300)));    // 5 分钟最短窗口（只在提前停开启时用）
// ⚠ 2026-11-09 01:1x 实测：`收工自检.mjs --场景 命令 --json` **恒 EXIT=2**
//   （§〇 四小节硬匹配旧标题 + 记忆体检「第 4 节为空」，即 t78 那对历史口径冲突），
//   `改造后体检.mjs --快` 虽 EXIT=0 但恒绿、与「这一单是否做完」无关 ⇒ 两者都当不了
//   「全绿提前停」的真信号。⛔ 不造新判据、不改阈值消红 ⇒ 提前停**默认关闭**，
//   默认唯一生效路径就是 20 分钟硬兜底；宿主哪天把收工自检修绿了再开这个开关。
const ENABLE_EARLY_STOP = has('--用全绿提前停');

// 内挂自动交接：每 N 分钟跑一次（0 = 关）。默认 30 分钟；`--无自动交接` 关掉。
// ★ 2026-11-07：内挂「自动交接.mjs --执行 --quiet」是**静默强换**，与宿主最新令冲突 ⇒ 默认关闭。
//   换会话统一走 待询问队列 → 询问 → 【确认换会话】→ 交接.mjs --panel <panel> --go --force。
const AUTO_HANDOVER = has('--无自动交接') ? 0 : Math.max(0, Number(val('--自动交接', 0)));

// ══════════════════════════════════════════════════════════════════════════
// ★★ 2026-11-02 六改（宿主原话：「哨兵不要那么频繁，压缩上下文等别人思考完了再说呀」）★★
//
//   两个毛病，都是我造成的：
//     ① **太频繁**：每 60 秒一轮，只要有会话在思考就打一行日志 —— 一小时 60 行，
//        大半是"某某(38%, 思考480s)"这种毫无信息量的翻页。
//     ② **打扰正在干活的人**：原来把"你该压缩上下文了"推给 `running=true` 的会话，
//        可引擎根本压不了运行中的自己（`Compaction is unavailable ... agent is not idle`），
//        人家正在解题，被塞一句"去压缩" ⇒ 只能回"稍后"，纯打断。
//
//   ⇒ 新规矩（按"这条消息该在什么时候出现"分家，不再一锅端）：
//       只对 **running=true**：卡死告警、思考超时   —— 这俩是"你在干活但出事了"
//       只对 **running=false**：压缩提醒、收尾预警、换会话 —— 这仨是"你干完了，该做个体检"
//     空闲时推，正好是它刚好停手的那一下 —— 看完就能动手，不会被插进思考中间。
//     正在跑但已过线的，**记成"待办"**（日志里可见），等它一空闲就补推。
//
//   另外，同一个提醒不再每小时重发：
//       压缩 6 小时 1 次（或 pct 又涨 ≥10 个点）
//       收尾 12 小时 1 次 ／ 换会话 6 小时 1 次
// ══════════════════════════════════════════════════════════════════════════
const REPEAT_GATE_MS = Math.max(1, Number(val('--重提换会话', 6))) * 3600 * 1000;
// ★★ 2026-11-03 13:10 宿主定：「**不用加 cd 什么 6 小时 12 小时，空闲十分钟如果超了就压缩**」
//   ⇒ **压缩/收尾的时间冷却全部删除**（原来 压缩 6h、收尾 12h）。新判据只有两条，都是关系：
//     ① **空闲够 10 分钟**（不是"上次提醒过了多久"）—— 等人家思考完（宪法 §4.7 第 6 条）
//     ② **成本过线**（≥ 压缩线 240k）
//     两条同时成立 ⇒ 立刻走 [询问 → 验证闸 → /compact]，**不看上次压过多久**。
//
//   ⚠ 为什么删得掉而不会"压完再压"：压缩**成功**的判据是「tok 真的降了」（< 98%），
//     降了就掉到线以下 ⇒ 第二条判据自然不成立。所以不需要冷却去防重复压缩 ——
//     真正防重复的是"成本降了"这个事实，不是时钟。
//   ⚠ 仍然保留**唯一的**短重试：压缩**失败**（命令报错 / tok 没降）后 10 分钟内不重试。
//     这不是冷却，是"别对着一个压不动的会话每 3 分钟锤一次"；10 分钟后照常重试，
//     连续 3 次失败会升级成 `_待办.md` 里的显眼报警（recordAction）。
const IDLE_BEFORE_COMPACT_MS = Math.max(1, Number(val('--空闲多少分', 10))) * 60 * 1000;
const COMPACT_RETRY_MS = 10 * 60 * 1000;    // 压失败的短重试（⛔ 不是 6h 冷却）
const QUEUE_LOG_MS = 30 * 60 * 1000;        // "在跑⇒排队"那行日志的去重间隔（纯日志）
const HEARTBEAT_LOG_MS = 30 * 60 * 1000;   // 哨兵「我在岗」的自报间隔（只在没别的话可说时）
const STATE_FILE = path.join(ROOT, '引擎', '.tmp', 'session-sentinel-state.json');
// ★ 心跳文件：给「启动哨兵.cmd」判断"我还活着"用。
//   为什么不查进程名：本机 wmic 已被移除，Get-CimInstance 又被沙箱拒 ⇒ 查不到。
//   心跳更准：进程死了文件就不更新，外面一层按 mtime 超时即可判定。
const HEARTBEAT_FILE = path.join(ROOT, '引擎', '.tmp', 'session-sentinel.alive');
// ★ 单实例锁（2026-11-03 16:45 新增 · 派单第 ④ 条）
//   事故：15:28:30 起有**两个**哨兵进程（PID 34940 父=electron、39904 父=守护），
//   从此 `session-sentinel.log` **每一行都成对出现**（催促推两遍、16:28:31 与 16:29:01 各压一次，
//   第一条还报 `agent is not idle`）⇒ 宿主问「怎么发了两遍」。
//   根因：`哨兵守护.mjs` 拉起前**没有"已经有一个在跑"的检查**，哨兵自己也没有锁。
//   ⇒ 双保险：① 守护拉起前先看心跳；② 哨兵启动时拿锁，拿不到就干净退出 + 写一行日志。
const LOCK_FILE = path.join(ROOT, '引擎', '.tmp', 'session-sentinel.lock');

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-02 第三次改判据：**文件 MB 被本机实测证伪，改成 pressureTokens** ★★★
//
//  历史：七改时宿主说「以你说的为准而不是图片里的上下文 70%」，我据此把判据
//        全部改成会话文件 MB（2.4 / 2.0 / 1.5）。**那一步是错的，现在纠正。**
//
//  证据一（负相关，12 面板实测，见 工具\_量纲对拍.mjs）：
//    pressureTokens vs 真实成本   1.000   ← 引擎自己算的，就是账单上那个数
//    surfaceTokens                 0.881
//    会话文件 MB                  -0.380   ← **负相关！文件越大反而越便宜**
//  具体反例（同一次快照）：
//    cmd-chat  4.41 MB / 130k tok   （文件最大，成本中等 —— 已经 fork+压缩过）
//    dg-gui    1.33 MB / 243k tok   （文件最小之一，成本最高 —— 81% 窗口）
//    dg-dsh    2.01 MB /  21k tok   （文件 84% 满线，实际几乎是空的）
//  ⇒ 按 MB 判断：反复压缩"文件大但便宜"的（白花钱），
//    同时完全看不见"文件小但极贵"的（dg-gui 已 81% 窗口，MB 上只有 1.33）。
//
//  证据二（fork 不降本，见 工具\_验fork降本.mjs，58 条历史会话全量比对）：
//    命令      5bcd81f6 45轮 68,335 tok → a14be0cf 45轮 68,335 tok   （完全相同）
//    视频工作流 f125f20d 21轮 123,593   → 连 4 代全是 123,593        （完全相同）
//  ⇒ **交接 = 纯复制，一个 token 都不降。** 按"超线就交接"跑 = 花钱、换人、成本照旧，
//    正是宿主抱怨「隔一会就要换个会话，这明显降低了效率」的直接原因。
//
//  ★ 三档重新定义（判据是绝对 token；窗口占比只用于显示和兜底）：
//      成本 ≥ 压缩线 120k（40% 窗口）          ⇒ 【压缩】 /compact，机械操作，**真降本**
//      成本 ≥ 收尾线 180k（60% 窗口）          ⇒ 【开始写收尾】让 §〇 时刻新鲜，但不换人
//      成本 ≥ 窗口 90% 且**已压缩过**且空闲够   ⇒ 【兜底交接】压缩治不了才换人
//  ⛔ 再也不会出现「文件到 2.4 MB 就交接」——那条已被实测否掉。
// ══════════════════════════════════════════════════════════════════════════
const COST_COMPACT = Number(val('--tok压缩', 240000));   // 压缩线（80% 窗口 · 宪法 §11）
// ⛔ 收尾线**必须严格小于**压缩线（2026-11-03 07:55 事故：两者都写 240k ⇒
//   收尾分支先命中并 continue ⇒ 压缩前的「落盘询问」永远发不出去。
//   宿主原话：「哨兵怎么没有问你然后压缩上下文」)。
//   取 200k（约 67%）：给会话留出"把进度写进 §〇"的时间窗，又不至于到压缩线才催。
const COST_WARN = Number(val('--tok收尾', 200000));

// ★★★ 2026-11-03 18:10 新增·**步数闸 / 输出量闸**（runaway 报警）★★★
//   宿主 17:29 放行「省 token 省时间」；命令实测：步/轮是耗时的第一解释变量
//     （步/轮 4~5 ⇒ 每轮 36~40s；步/轮 33~53 ⇒ 每轮 300~513s，几乎 1:1 线性）。
//   ⇒ 步数闸 = **当场**提示"你跑太多趟了"，而不是等宿主 8 分钟后自己发现。
//   ⛔ 本闸**只报警、不阻断**：不压缩、不改会话、不派单（判据见 stepGateVerdict 注释）。
//   ⛔ 阈值必须可覆盖（--步数上限 / --输出上限），默认值写死在这里（8 / 8000）。
const STEP_LIMIT = Number(val('--步数上限', 8));      // 步/轮上限：> 8 ⇒ 判「跑太多趟」
const OUTPUT_LIMIT = Number(val('--输出上限', 8000));  // 输出 token/轮上限：> 8000 ⇒ 判「输出过长」
const STEP_GATE_WINDOW = 3;   // 取最近 3 轮的均值（短会话噪声大，单轮会误判）
const COST_GATE_RATIO = Number(val('--tok交接比', 1.0));  // 兜底交接：窗口的 100%（413 线）
// ★ 2026-11-02 23:00 加：压缩前必须先问会话「有没有要留的」（宿主定，见 B③ 段注释）
const ASK_RETRY_MS = Math.max(60, Number(val('--问重试', 600))) * 1000;  // 没回话 ⇒ 10 分钟后重问
const ASK_MAX = Math.max(1, Number(val('--问最多', 3)));                  // 最多问 3 次；3 次不回也不压
const ANSWER_TAGS = ['【已落盘】', '【无需落盘】'];                        // 会话回话的暗号（一字不改）
// ★★ 2026-11-07 19:19 宿主最新令（与 14:51 回滚口径相反，以本句为准）：
//   「先修复自动换会话的事情，哨兵这两还是要加的，一个是询问换会话，一个是十分钟20分钟30分钟催促」
//   ⇒ 换会话必须先向会话发一句询问、拿到确认才走 交接.mjs --go --force；⛔ 不静默强换、不问旧【已落盘】暗号。
const HANDOVER_TAG = '【确认换会话】';
// ★ 2026-11-08 12:51 宿主令「询问需要换会话」：新口令与旧暗号都认，⛔ 不静默强换
const HANDOVER_TAGS = [HANDOVER_TAG, '需要换会话'];
// ⛔「不需要换会话 / 暂不需要换会话」不许被认成确认（宿主令：只有「需要换会话」才交接）
const HANDOVER_NEW_RE = /需要换会话/;
const HANDOVER_NEG_RE = /(?:不|别|无需|不用|暂不)\s*需要换会话/;
// ★ 2026-11-08 12:51：上下文急停.mjs 越 413 线只登记这里，压缩仍走 B③ 唯一入口
const COMPACT_ASK_QUEUE = path.join(ROOT, '工具', '_待压缩询问.json');
const COMPACT_QUEUE_LOG = path.join(ROOT, '工具', '_待压缩询问-处理.log');
const HANDOVER_ASK_RETRY_MS = 10 * 60 * 1000;   // 没确认 ⇒ 10 分钟后重问（同档不刷屏）
const HANDOVER_ASK_QUEUE = path.join(ROOT, '工具', '_待询问换会话.json');
// ★★ 2026-11-08 宿主令「不要一直让哨兵问换会话了」：修「陈旧队列项永生 / 不认暂不换」四个洞。
//   · 长冷静 24 小时：宿主回「暂不换 / 先别换」后，24h 内不再问、登记侧也拒收（⛔ 不刷屏）。
//     选 24h 而不是 10min：拒绝是「人已经判断过一次」，不该被哨兵用轮询周期磨掉。
//   · 冷静文件是 会话哨兵.mjs 与 上下文急停.mjs 两个进程共享的持久事实（队列会被清空，不能只写在内存）。
//   · 处理日志只落本地，不向会话发任何额外消息。
const HANDOVER_DECLINE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const HANDOVER_DECLINE_RE = /暂不换|先别换|不要换会话|别换会话/;
const HANDOVER_COOL_FILE = path.join(ROOT, '工具', '_换会话冷静.json');
const HANDOVER_QUEUE_LOG = path.join(ROOT, '工具', '_待询问换会话-处理.log');
// ⚠ 下面几个保留，只为兼容老参数/老日志；**不再参与任何判据**，仅用于显示。
const MB_WARN = Number(val('--mb预警', 2.0));
const MB_GATE = Number(val('--mb', 2.4));
const MB_COMPACT = Number(val('--mb压缩', 1.5));
const MB_COMPACT_GROW = Number(val('--压缩涨幅', 0.5));
const PCT_COMPACT = Number(val('--pct压缩', 70));

/** 会话文件大小（MB）：从 .dsh\sessions\<workspace>\<sessionId>\*.zstd 读实际字节 */
function sessionFileMB(sessionId) {
  try {
    const base = path.join(ROOT, '引擎', '.dsh', 'sessions');
    if (!fs.existsSync(base)) return null;
    for (const ws of fs.readdirSync(base)) {
      const d = path.join(base, ws, sessionId);
      if (!fs.existsSync(d)) continue;
      const f = fs.readdirSync(d).find((x) => x.endsWith('.zstd'));
      if (f) return fs.statSync(path.join(d, f)).size / (1024 * 1024);
    }
  } catch { /* ignore */ }
  return null;
}

const SELF_TEST = has('--自测');
const GATE_TEST = has('--闸自测');        // 真文件端到端自测（建真目录、写真文档、跑真体检）
const SHOW_TICKETS = has('--票据');       // 只读台账、不连引擎（排障/验收用）
if (!LOOK && !WATCH && !SELF_TEST && !GATE_TEST && !SHOW_TICKETS && !has('--换会话干跑') && !has('--换会话复算')) {
  console.error('用法：node 工具\\会话哨兵.mjs --看 | --盯 [--间隔 180] [--思考 600] [--卡死 600] [--干跑] | --自测 | --闸自测 | --票据');
  process.exit(1);
}

// ── 场景表：panel/session → 场景名 ──
function loadScenes() {
  const map = new Map();
  for (const f of fs.readdirSync(SCEN).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (!j || !j.id) continue;
    for (const p of (j.panels || [])) {
      if (!p || p.type !== 'harness' || !p.sessionId) continue;
      map.set(p.sessionId, { scene: j.name || j.id, sceneId: j.id, panel: p.title || p.id, panelId: p.id || '', sessionTitle: p.sessionTitle || '' });
    }
  }
  return map;
}

// ── 引擎 RPC ──
const TOKEN_RE = new RegExp('http:\\/\\/127\\.0\\.0\\.1:' + DSH_PORT + '(?:\\/\\?)?token=([A-Za-z0-9_\\-]{16,})', 'g');
async function getCookie() {
  const logs = [path.join(ROOT, '外壳', 'server.log'), path.join(ROOT, '引擎', 'server.log')];
  const toks = [];
  for (const lp of logs) {
    if (!fs.existsSync(lp)) continue;
    for (const m of fs.readFileSync(lp, 'utf8').matchAll(TOKEN_RE)) toks.push(m[1]);
  }
  toks.reverse();
  for (const t of toks.slice(0, 6)) {
    try {
      const r = await fetch('http://127.0.0.1:' + DSH_PORT + '/?token=' + t, { redirect: 'manual' });
      const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      if (sc.length) return sc.map((c) => c.split(';')[0]).join('; ');
    } catch { /* 下一个 */ }
  }
  return '';
}

async function rpc(cookie, method, args) {
  const r = await fetch('http://127.0.0.1:' + DSH_PORT + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _http: r.status, _raw: t.slice(0, 200) }; }
}

// ★ 2026-11-01 四改：每轮重取 cookie —— 治"哨兵看起来在跑、其实早哑了"
//   根因：cookie 是启动时换的签名 cookie，**工作台一重启 token 就全变**，旧 cookie 立刻失效。
//   老版只在 main() 里取一次 ⇒ 工作台重启后每一轮 session/list 都 401/空 ⇒
//   判据拿不到数据 ⇒ 静默返回 ⇒ **进程活着、日志不动、警报永远不发**。
//   今天下午 14:36 之后状态文件就再没更新过，就是这种"假在岗"（当时是压根没启动，症状一样）。
//   ⇒ 现在每轮 tick 都重取；取到就用新的，取不到就沿用旧的再试。
let COOKIE = '';
async function ensureCookie(force) {
  if (!force && COOKIE) return COOKIE;
  try {
    const c = await getCookie();
    if (c) COOKIE = c;
  } catch { /* 引擎在重启中：保留旧 cookie，下一轮再试 */ }
  return COOKIE;
}
/** 引擎是否真的在响应（不是"进程在但 401"） */
async function engineAlive() {
  const c = await ensureCookie(true);
  if (!c) return false;
  try {
    const r = await rpc(c, 'session/list', { _request: {} });
    return !!(r && r.result && r.result.ok && r.result.value && Array.isArray(r.result.value.items));
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════════════════════
// ★ 2026-11-02：把「什么时候该催第几档 / 什么时候该报卡死」抽成纯函数。
//   为什么要抽：这两个判据是整套逻辑里最容易写错的地方（已经错过两次），
//   而用"伪造 state + 跑真进程"来测很不靠谱 —— 实时快照会盖掉伪造值。
//   抽出来后就能用固定输入跑断言，`--自测` 直接验，不用等真的卡 10 分钟。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 收口判定（2026-11-09 新增，纯函数 ⇒ `--自测` 能正反打、能失败）。
 *   ⛔ 只看「本轮跑了多久 + 收工自检是否全绿 + 这一轮是否已投过」，绝不读模型状态、
 *      绝不新增判据、绝不塞提示层。已投过就永久闭嘴（一轮只一句）。
 */
function stopDecision(stepSec, green, sent, minSec, maxSec) {
  if (sent) return { due: false, reason: '已投过' };
  if (stepSec >= maxSec) return { due: true, reason: '硬上限' };
  if (green && stepSec >= minSec) return { due: true, reason: '验收全绿' };
  return { due: false, reason: '未到条件' };
}

/** 复用**已有**的 `收工自检.mjs --json`：退出码 0 = 全绿。任何异常/超时一律 false（宁可不提前停，不许误杀）。 */
function closingGreen(sceneName) {
  try {
    const r = spawnSync(process.execPath,
      [path.join(ROOT, '工具', '收工自检.mjs'), '--场景', sceneName, '--json'],
      { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}

/** 停令文案：只给一句「停，给结论」。⛔ 不问进度、不让自评 —— 那正是 t78 43.7% 的字。 */
function stopText(reason, maxMin) {
  return reason === '验收全绿'
    ? '停，给结论。\n验收判据已全绿：不用再展开、不用再重述计划，直接给最终结果（产物路径 / 还差什么 / 有无卡点），结束这一单。'
    : '停，给结论。\n已到 ' + maxMin + ' 分钟硬上限：不再开新步骤，直接给最终结果（产物路径 / 未达项如实列出 / 有无卡点），结束这一单。';
}

/**
 * 催进度（旧）：返回该推的档位（0 = 不推）。档位封顶 3，对应 10/20/30 分钟。
 * ⚠ 2026-11-09 起**默认停用**（主流程改走收口闸门）；仅 `--用旧催办` 回退时启用，
 *   函数与自测原样保留 ⇒ 拆掉新逻辑能立刻退回旧行为，不重写历史。
 */
function nudgeTierFor(stepSec, lastTier, thinkSec) {
  if (!stepSec || stepSec < thinkSec) return 0;
  const tier = Math.min(3, Math.max(1, Math.floor(stepSec / thinkSec)));
  return tier > (Number(lastTier) || 0) ? tier : 0;
}

/**
 * 催促文案（2026-11-02 宿主重新设计，三档各管一件事）
 *
 *   宿主原话：「已经10分钟，进度如何，催促一下」
 *            「20分钟就：20分钟了，麻烦加快进度」
 *            「30分钟再说进度如何，让场景回复进度，因为有些东西就是要很长时间的，
 *              让场景自己评估下难易度实现程度预计时间，而不是直接最小可行版本，这样子其实不好」
 *
 *   设计原则（别再改回去）：
 *     ① 催促 = **问进度 + 请加速**，不是逼它砍需求
 *     ② 30 分钟档 = **让场景自评**（难度/完成度/预计时间），因为长任务是正常的
 *     ③ ⛔ 绝不说"只做最小可用版本"、"先交一半" —— 那会把正经活逼成半成品
 *     ④ 三档之后**不再催**（同一轮里翻来覆去催会毁掉思路），交给「疑似卡死」兜底
 */
function nudgeText(tier, stepMin) {
  if (tier === 1) {
    return '【催一下】已经 ' + stepMin + ' 分钟了，进度如何？\n'
      + '接着做，有卡点就说一声。';
  }
  if (tier === 2) {
    return '【催一下】' + stepMin + ' 分钟了，麻烦加快进度。\n'
      + '如果碰到绕不过去的坎，直接说是哪个坎。';
  }
  return '【进度汇报】' + stepMin + ' 分钟了，说一下现在的进度：\n'
    + '① 已经做到哪一步（有产物就写路径）\n'
    + '② 还剩什么没做\n'
    + '③ 这件事的难易度 / 你估计还要多久\n'
    + '④ 有没有需要我协调的\n'
    + '长任务我理解，我要的是你的判断，不是让你砍需求。';
}

/**
 * 进度三元组的规范化。引擎 sessionStats 里这三个量都是**单调累加**的：
 *   steps  已完成步数 · toolMs 工具累计耗时 · llmMs 模型累计耗时
 * 缺失/非数字一律按 0，不让 undefined 参与比较（`undefined > 3` 恒 false，会静默判成"没进展"）。
 */

// ══════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-03 18:10·**步数闸 / 输出量闸**（纯函数，可正反打）★★★
//
// ★ 判据必须是**关系**，不能是快照（这是哨兵自己栽过的第 3 次：
//   answeredThisAsk 用 `.slice(-8)` 看"最近 8 轮"，8 小时前的 askSeq 又从不清零，
//   ⇒ 旧暗号被当成这一次的回答 ⇒ 16:28 没问就压了）。
//   ⇒ 这里**绝不**用"最近 N 步/最近 N 轮"这种按条数截断的写法。
//
// ★ 怎么做到「最近 3 轮」而不用条数截断：
//   sessionStats 里只有**累计值**（turns/steps/decodeTokens），没有分轮明细。
//   ⇒ 用**累计差分**还原每一轮：相邻两次采样之间 turns 涨了几 ⇒ 那几轮各跑了多少步。
//   ⇒ 维护一个**滚动窗口**（最多 3 个「轮次增量」样本），对窗口内的比值求均值。
//   ⇒ 这是**关系**（"这一轮多了几步"），不是"最近 8 步"这种快照。
//
// ★ 判据（两条闸合并成一条提醒，别推两条骚扰宿主）：
//   ① 步数闸：avgStepsPerTurn > stepLimit       ⇒ 「步数超标」（跑太多趟，该并行/该一步到位）
//   ② 输出闸：avgDecodePerTurn > outputLimit   ⇒ 「输出过长」（结论该写进文件，回复只留摘要）
//   两个都超 ⇒ 两条都报（文案里都列出来）。
//
// @param {object} o
// @param {number} o.turns        累计轮次
// @param {number} o.steps        累计步数
// @param {number} o.decodeTokens 累计输出 token（sessionStats.decodeTokens）
// @param {object} o.prev         上一 tick 的快照 {turns,steps,decodeTokens,hist:[]}
// @param {number} o.stepLimit    步/轮上限（默认 8）
// @param {number} o.outputLimit  输出 token/轮上限（默认 8000）
// @param {number} o.window       滚动窗口轮数（默认 3）
// @returns {{stepsPerTurn:number, decodePerTurn:number, overSteps:boolean, overOutput:boolean,
//            hit:boolean, reasons:string[], next:object, samples:number}}
function stepGateVerdict(o) {
  const opt = o || {};
  const turns = Number(opt.turns) || 0;
  const steps = Number(opt.steps) || 0;
  const dec = Number(opt.decodeTokens) || 0;
  const prev = opt.prev || {};
  // ⚠ 兜底必须引用**同源常量**，不能在这里写死 8：
  //   写死 ⇒ 变异「把 8 改成 80」只改 CLI 常量时，判据读不到 ⇒ 自测假绿（今天吃过这个亏）。
  const stepLimit = Number(opt.stepLimit) > 0 ? Number(opt.stepLimit) : STEP_LIMIT;
  const outputLimit = Number(opt.outputLimit) > 0 ? Number(opt.outputLimit) : OUTPUT_LIMIT;
  const window = Number(opt.window) > 0 ? Number(opt.window) : 3;
  const hist = Array.isArray(prev.hist) ? prev.hist.slice(-(window - 1)) : [];

  // ── 累计差分 ⇒ 这一轮新增了几个 turn / 几步 / 多少输出 token ──
  const pTurns = Number(prev.turns) || 0;
  const pSteps = Number(prev.steps) || 0;
  const pDec = Number(prev.decodeTokens) || 0;
  const dTurns = turns - pTurns;
  const dSteps = steps - pSteps;
  const dDec = dec - pDec;
  let samples = hist.slice();
  // 只有**真的多了一轮以上**且步数/输出**没倒退**时，这个样本才有意义。
  //   ⛔ dTurns<=0（没新轮次）⇒ 不加样本（否则"停着不动"会被算成 0 步/轮，把闸压住）
  //   ⛔ dSteps<0 或 dDec<0（计数器重置/换会话）⇒ 丢弃整个历史，重新起算
  if (dTurns > 0 && dSteps >= 0 && dDec >= 0) {
    samples.push({ turns: dTurns, steps: dSteps, decode: dDec });
    if (samples.length > window) samples = samples.slice(-window);
  }
  const next = { turns, steps, decodeTokens: dec, hist: samples };

  // ── 窗口内的均值（关系：增量之比）──
  let sTurns = 0, sSteps = 0, sDec = 0;
  for (const h of samples) { sTurns += h.turns; sSteps += h.steps; sDec += h.decode; }
  const stepsPerTurn = sTurns > 0 ? sSteps / sTurns : 0;
  const decodePerTurn = sTurns > 0 ? sDec / sTurns : 0;

  // ⚠ 阈值语义 = **达到上限即报**（>=），不是「严格超过」（>）：
  //   派单自测第 ⑦ 条明写「--步数上限 3 ⇒ 3 步/轮就报」⇒ 3 > 3 必为 false ⇒ 只能用 >=。
  //   另：踩到上限本身就值得提醒（再跑一步就超），比真超线早一档。
  const overSteps = samples.length > 0 && stepsPerTurn >= stepLimit;
  const overOutput = samples.length > 0 && decodePerTurn >= outputLimit;
  const reasons = [];
  if (overSteps) reasons.push('步数超标');
  if (overOutput) reasons.push('输出过长');
  return {
    stepsPerTurn: Math.round(stepsPerTurn * 10) / 10,
    decodePerTurn: Math.round(decodePerTurn),
    overSteps, overOutput,
    hit: overSteps || overOutput,
    reasons,
    next,
    samples: samples.length,
  };
}
function normProgress(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    steps: Number(p.steps) || 0,
    toolMs: Number(p.toolMs) || 0,
    llmMs: Number(p.llmMs) || 0,
    at: Number(p.at) || 0,          // 采样时刻（ms）。0 = 不知道，只比数值
  };
}

/**
 * ★★★ 三期移植·一期核心判据：**有没有实质进展** ★★★
 *
 * hasProgress(prev, cur, windowSec) → true / false
 *
 *   三元组 `steps / toolMs / llmMs` **任一在观察窗口内增长** ⇒ true（有实质进展）。
 *   三者全不动且窗口已经填满                       ⇒ false（明确停滞）。
 *
 * 为什么三选一而不是只看 steps：
 *   一次长工具调用（`npm install`、`node --check` 大文件）可能几分钟不涨 steps，
 *   但 toolMs 会一直涨；反过来纯思考长时，steps/toolMs 都不动而 llmMs 在涨。
 *   只看一个量必然误判 —— 这正是原来用 `updatedAt` 判活会翻车的原因。
 *
 * 为什么窗口没填满时返回 true（而不是 false）：
 *   哨兵默认 3 分钟一轮，而 `--卡死` 默认 10 分钟。刚催完第一轮时窗口还不满，
 *   此时**没有资格**断言"停滞"。宁可晚一轮报，也不能把正在干活的人报成卡死。
 *   ⇒ 判据只负责"能证明有进展"和"能证明停滞"，其余一律不指控。
 *
 * ⛔ 不许在这里读 updatedAt —— 实测它不是心跳（12 分钟不动而 steps 涨了 3）。
 */
function hasProgress(prev, cur, windowSec) {
  const a = normProgress(prev);
  const b = normProgress(cur);
  if (!b) return true;                       // 拿不到当前值 ⇒ 不指控
  if (!a) return true;                       // 没有基线 ⇒ 不指控
  if (b.steps > a.steps || b.toolMs > a.toolMs || b.llmMs > a.llmMs) return true;
  // ── 数值一个没涨：只有"窗口确实填满了"才敢说停滞 ──
  const win = Math.max(0, Number(windowSec) || 0) * 1000;
  if (!win) return false;                    // 明确要求"只比数值"（测试用）⇒ 没涨就是没涨
  if (!a.at || !b.at) return true;           // 不知道隔了多久 ⇒ 不指控
  return (b.at - a.at) < win;                // 窗口没满 ⇒ 不指控
}

/** 进度指纹：用于"同一段停滞只报一次"。⛔ 不要用时间戳做键（时间戳会动，指纹不会）。 */
function progressKey(p) {
  const n = normProgress(p) || { steps: 0, toolMs: 0, llmMs: 0 };
  return n.steps + '|' + n.toolMs + '|' + n.llmMs;
}

// ══════════════════════════════════════════════════════════════════════════
// ★ 2026-11-02 三期：**收工未回执自动催**（宿主那条规矩的机器版）
//
//   宿主原话：「**各个场景结束后要跟你汇报，然后你总结给我；我看没有跟你说你也没找我汇报**」
//
//   为什么必须机器化：光写文档已经证明没用 —— 程序开发 17:55 接单、18:18 干完，
//   一期 48/48 全绿，**通道上一次回执都没发**。宿主看到的就是"干完了不吭声"。
//   文档里"必须回执"写了三遍，照样漏 ⇒ 只能让机器在"收工这一刻"堵住它。
//
//   触发（缺一不可）：
//     ① 该会话 `running` 由 **true → false**（真的收工了，不是一直在跑）
//     ② 它名下**有未回执的派单**（done=false）
//     ③ 不是归档会话、不是**命令自己**（isSelf）
//     ④ 同一单 30 分钟内不重复催（冷却记在 state 上）
// ══════════════════════════════════════════════════════════════════════════
const RECEIPT_ASK_COOL_MS = 30 * 60 * 1000;

/**
 * 该催哪几单？—— 纯函数，返回**要催的单子数组**（空数组 = 不催）。
 * （`--自测` 直接喂固定输入验，不跑引擎、不写文件）
 *
 * @param prevRunning 上一轮 running（state 里记的）
 * @param curRunning  本轮 running
 * @param openTickets 该会话名下的派单（元素形如 {ts, head, done, archived, isSelf}）
 * @param st          该会话的 state（用 st.receiptAsked = { 单键: 时刻 } 记冷却）
 * @param now         当前时刻（ms），不传就用 Date.now（自测传固定值）
 */
function receivableTickets(prevRunning, curRunning, openTickets, st, now = Date.now()) {
  if (!prevRunning) return [];                      // 上一轮就不在跑 ⇒ 不是"收工那一刻"
  if (curRunning) return [];                        // 还在跑 ⇒ 别打断
  const list = Array.isArray(openTickets) ? openTickets : [];
  const asked = (st && st.receiptAsked) || {};
  const out = [];
  for (const t of list) {
    if (!t) continue;
    if (t.done) continue;                           // 已回执 ⇒ 不催
    // ★ 2026-11-02 命令第 8 单要求：**已登记忽略的单不许催**
    //   真事：17:49 那张空壳单，命令明说「请忽略，不追」。
    //   台账里它现在 done=true 所以没炸；但只要判据再动一次它变红，
    //   哨兵就会去催一张**根本不存在的单** —— 宿主会看到"催我回一张早说不要了的单"。
    //   ⇒ 忽略标记必须一路传到判据里，⛔ 不能只在台账显示层生效。
    if (t.ignored) continue;                        // 已登记忽略 ⇒ 不催
    if (t.archived) continue;                        // 已归档 ⇒ 不催
    if (t.isSelf) continue;                          // 命令自己 ⇒ 不催
    const last = Number(asked[openTicketKey(t)]) || 0;
    if (last && (now - last) < RECEIPT_ASK_COOL_MS) continue;   // 冷却中 ⇒ 不重复催
    out.push(t);
  }
  return out;
}

/** 该不该催它补回执？返回**要催几单**（0 = 不催）。 */
function shouldAskReceipt(prevRunning, curRunning, openTickets, st, now = Date.now()) {
  return receivableTickets(prevRunning, curRunning, openTickets, st, now).length;
}

/** 未回执的单子键（用于写冷却，和 receivableTickets 内部算法必须一致） */
function openTicketKey(t) {
  return String((t && t.ts) || '') + '|' + String((t && t.head) || '').slice(0, 40);
}

/**
 * 读 `查回执台账.mjs --json`，按 sessionId 归组。
 * ⚠ 为什么不在这里重写一套判据：回执核账的判据只允许有**一个**真源
 *   （它自己刚被修过假阳性）。哨兵再抄一份 ⇒ 两份判据迟早跑偏。
 * 读不到就返回空 Map ⇒ 本轮不催（宁可漏催一次，也不拿错数据去骚扰人）。
 */
async function loadTicketsBySession() {
  const out = new Map();
  try {
    const { spawnSync } = await import('node:child_process');   // ⚠ ESM 里没有 require
    const r = spawnSync(process.execPath, [path.join(ROOT, '工具', '查回执台账.mjs'), '--全部', '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    const txt = String(r.stdout || '');
    const i = txt.indexOf('[');
    if (i < 0) return out;
    const rows = JSON.parse(txt.slice(i));
    for (const x of rows) {
      if (!x || !x.sessionId) continue;
      const arr = out.get(x.sessionId) || [];
      arr.push({ ts: x.ts, head: x.head, done: !!x.done, ignored: !!x.ignored });
      out.set(x.sessionId, arr);
    }
  } catch { /* 读不到就本轮不催 */ }
  return out;
}

/**
 * 疑似卡死：只有"催过 + 催完又没有实质进展"才报。返回是否该报。
 *
 * ★ 2026-11-02 三期移植·一期：判据从 `updatedAt`（最后事件时间）换成
 *   `progress`（steps/toolMs/llmMs 累计量增量）。updatedAt 只保留显示用途。
 *
 * @param now            当前时刻 ms
 * @param nudgedAt       上次催促时刻 ms（0 = 没催过 ⇒ 不查尸）
 * @param prevProgress   上一轮采样 {steps,toolMs,llmMs,at}
 * @param curProgress    本轮采样   {steps,toolMs,llmMs,at}
 * @param stallSec       卡死阈值（秒）
 * @param lastStalledKey 上次报警时的进度指纹（progressKey），用于去重
 */
function shouldReportStall(now, nudgedAt, prevProgress, curProgress, stallSec, lastStalledKey) {
  if (!nudgedAt) return false;                                   // 没催过 ⇒ 不查尸
  if ((now - nudgedAt) < stallSec * 1000) return false;          // 刚催完，给它时间动
  if (hasProgress(prevProgress, curProgress, stallSec)) return false;  // 有进展 ⇒ 没卡
  return lastStalledKey !== progressKey(curProgress);            // 同一段停滞只报一次
}

/** 自测：判据表，错了就 exit 1。`node 工具\会话哨兵.mjs --自测` */
async function selfTest() {
  // ★ 先读源码：下面好几条静态断言都要用它（放在最前面，避免 TDZ）
  let selfSrc = '';
  try { selfSrc = fs.readFileSync(new URL(import.meta.url), 'utf8'); } catch { selfSrc = ''; }
  const T = 600, S = 600, now = 1_000_000_000_000;
  // 卡死判据用的固定样本：base = 催之前的采样，same = 数值一个没涨的当前采样。
  //   at 相差 30 分钟 ⇒ 窗口（S=600s）早已填满 ⇒ 有资格判"停滞"。
  const stallBase = { steps: 100, toolMs: 200000, llmMs: 300000, at: now - 30 * 60e3 };
  const stallSame = { steps: 100, toolMs: 200000, llmMs: 300000, at: now };
  const cases = [
    // ── 2026-11-08 12:51 · 新口令「需要换会话」与压缩询问链路 ──
    ['【新口令】HANDOVER_TAGS 必须同时认新旧确认语',
      HANDOVER_TAGS.includes('【确认换会话】') && HANDOVER_TAGS.includes('需要换会话'), true],
    ['【新口令】回「需要换会话」⇒ 认到确认（不是静默强换）',
      confirmedHandover({ outline: [{ seq: 2, response: '需要换会话' }] },
        { handoverAskAt: 1, handoverAskSeq: 1, handoverAskResp: '旧话' }), true],
    ['反：没问过就不许认任何确认语',
      confirmedHandover({ outline: [{ seq: 9, response: '需要换会话' }] }, {}), false],
    ['反：「不需要换会话」不许被当成确认（否定句防误换）',
      confirmedHandover({ outline: [{ seq: 2, response: '不需要换会话' }] },
        { handoverAskAt: 1, handoverAskSeq: 1, handoverAskResp: '旧话' }), false],
    ['反证：否定排除不许误伤「我觉得需要换会话」',
      confirmedHandover({ outline: [{ seq: 2, response: '我觉得需要换会话' }] },
        { handoverAskAt: 1, handoverAskSeq: 1, handoverAskResp: '旧话' }), true],
    ['静态：源码必须有压缩询问队列销项入口', selfSrc.includes('processCompactAskQueue'), true],
    ['静态：源码必须把急停登记项点亮 B③（不新增 /compact）', selfSrc.includes('COMPACT_ASK_SIDS.has(r.sessionId)'), true],
    // ── 2026-11-08 · 换会话队列复算 / 认暂不换（4 类正反样本）──
    ['【陈旧队列+当场宽裕】30.9% running ⇒ 清项不重问',
      handoverDecision({ measure: { ratio: 0.309, running: true }, lines: { compressLine: 0.8, hardLine: 1 },
        st: { handoverAskAt: now - 20 * 60e3 }, now, confirmed: false, declined: false }).action, 'clear'],
    ['反：当场实测缺失 ⇒ fail closed，不擅自清项',
      handoverDecision({ measure: null, lines: { compressLine: 0.8, hardLine: 1 },
        st: { handoverAskAt: now - 20 * 60e3 }, now, confirmed: false, declined: false }).action, 'ask'],
    ['【认暂不换】回复「暂不换」⇒ 长冷静，不重问',
      handoverDecision({ measure: { ratio: 1.05, running: false }, lines: { compressLine: 0.8, hardLine: 1 },
        st: {}, now, confirmed: false, declined: true }).action, 'decline'],
    ['【认暂不换】24h 冷静内 ⇒ 仍不重问',
      handoverDecision({ measure: { ratio: 1.05, running: false }, lines: { compressLine: 0.8, hardLine: 1 },
        st: { handoverDeclinedAt: now - 3600e3 }, now, confirmed: false, declined: false }).action, 'cool'],
    ['反证：冷静过期（25h）⇒ 条件仍成立时恢复询问',
      handoverDecision({ measure: { ratio: 1.05, running: false }, lines: { compressLine: 0.8, hardLine: 1 },
        st: { handoverDeclinedAt: now - 25 * 3600e3 }, now, confirmed: false, declined: false }).action, 'ask'],
    ['【确认换会话】⇒ 仍真换（doHandover 链路一字未动）',
      handoverDecision({ measure: { ratio: 0.5, running: false }, lines: { compressLine: 0.8, hardLine: 1 },
        st: { handoverAskAt: now - 60e3 }, now, confirmed: true, declined: false }).action, 'handover'],
    ['【条件真达标】105% 越 413 线 ⇒ 仍登记并问一次',
      handoverDecision({ measure: { ratio: 1.05, running: false }, lines: { compressLine: 0.8, hardLine: 1 },
        st: {}, now, confirmed: false, declined: false }).action, 'ask'],
    ['【条件真达标】85% 压缩线 ⇒ 仍问一次',
      handoverDecision({ measure: { ratio: 0.85, running: false }, lines: { compressLine: 0.8, hardLine: 1 },
        st: {}, now, confirmed: false, declined: false }).action, 'ask'],
    ['【条件真达标】50% 但 running 卡死 700s ⇒ 不许清项',
      handoverDecision({ measure: { ratio: 0.5, running: true }, lines: { compressLine: 0.8, hardLine: 1 },
        st: { startedAt: now - 700e3 }, now, confirmed: false, declined: false }).action, 'ask'],
    ['反：50% running 仅 30s ⇒ 条件已消失，清项',
      handoverDecision({ measure: { ratio: 0.5, running: true }, lines: { compressLine: 0.8, hardLine: 1 },
        st: { startedAt: now - 30e3 }, now, confirmed: false, declined: false }).action, 'clear'],
    ['detector：询问之后出现「暂不换」⇒ 认',
      handoverDeclineOf({ outline: [{ seq: 1, prompt: '旧', response: '暂不换' },
        { seq: 5, prompt: '询问', response: 'x' }, { seq: 6, prompt: 'y', response: '好的，暂不换' }] },
      { handoverAskAt: now, handoverAskSeq: 5, handoverAskResp: '' }), true],
    ['detector 反：旧轮次的「暂不换」不算本次回答',
      handoverDeclineOf({ outline: [{ seq: 1, prompt: '旧', response: '暂不换' },
        { seq: 5, prompt: '询问', response: 'x' }] },
      { handoverAskAt: now, handoverAskSeq: 5, handoverAskResp: '' }), false],
    ['detector 反：没问过就不认（禁止旧回答冒充）',
      handoverDeclineOf({ outline: [{ seq: 9, prompt: 'y', response: '暂不换' }] },
      { handoverAskAt: 0, handoverAskSeq: 0, handoverAskResp: '' }), false],
    // ── 催进度 ──
    ['未到 10 分钟 ⇒ 不催', nudgeTierFor(300, 0, T), 0],
    ['正好 10 分钟 ⇒ 第 1 档', nudgeTierFor(600, 0, T), 1],
    ['15 分钟 ⇒ 仍是第 1 档', nudgeTierFor(900, 0, T), 1],
    ['已催过第 1 档，15 分钟 ⇒ 不重复', nudgeTierFor(900, 1, T), 0],
    ['已催第 1 档，20 分钟 ⇒ 升第 2 档', nudgeTierFor(1200, 1, T), 2],
    ['已催第 2 档，31 分钟 ⇒ 升第 3 档', nudgeTierFor(1860, 2, T), 3],
    ['已催第 3 档，60 分钟 ⇒ 封顶，不再推', nudgeTierFor(3600, 3, T), 0],
    ['已催第 3 档，120 分钟 ⇒ 仍封顶', nudgeTierFor(7200, 3, T), 0],
    ['120 分钟、从没催过 ⇒ 直接第 3 档（不是第 12 档）', nudgeTierFor(7200, 0, T), 3],
    // ── 疑似卡死（判据 = 累计量增量，⛔ 不是 updatedAt）──
    ['从没催过 + 10 分钟零进展 ⇒ 不报（先催，不查尸）',
      shouldReportStall(now, 0, stallBase, stallSame, S, ''), false],
    ['刚催完 1 分钟 + 零进展 ⇒ 不报（给它时间动）',
      shouldReportStall(now, now - 60e3, stallBase, stallSame, S, ''), false],
    ['催后 20 分钟 + 窗口内零进展 ⇒ 报',
      shouldReportStall(now, now - 20 * 60e3, stallBase, stallSame, S, ''), true],
    ['催后 1 小时 + steps 有涨 ⇒ 不报（正在干活）',
      shouldReportStall(now, now - 60 * 60e3, stallBase, { ...stallSame, steps: stallSame.steps + 3 }, S, ''), false],
    ['催后 1 小时 + 只有 toolMs 有涨 ⇒ 不报（长工具调用没涨 steps）',
      shouldReportStall(now, now - 60 * 60e3, stallBase, { ...stallSame, toolMs: stallSame.toolMs + 90000 }, S, ''), false],
    ['催后 1 小时 + 只有 llmMs 有涨 ⇒ 不报（纯长思考没涨 steps）',
      shouldReportStall(now, now - 60 * 60e3, stallBase, { ...stallSame, llmMs: stallSame.llmMs + 90000 }, S, ''), false],
    ['同一段停滞报过了 ⇒ 不重复',
      shouldReportStall(now, now - 20 * 60e3, stallBase, stallSame, S, progressKey(stallSame)), false],
    ['零进展但数值一变 ⇒ 是新的停滞段，要再报一次',
      shouldReportStall(now, now - 20 * 60e3, stallBase, stallSame, S, 'x|y|z'), true],
    ['拿不到当前进度 ⇒ 不指控',
      shouldReportStall(now, now - 20 * 60e3, stallBase, null, S, ''), false],
    ['没有基线 ⇒ 不指控',
      shouldReportStall(now, now - 20 * 60e3, null, stallSame, S, ''), false],
  ];
  // ── hasProgress：三元组任一增长即"有进展"（三期移植·一期）──
  const P0 = { steps: 10, toolMs: 5000, llmMs: 7000 };
  const growCases = [
    ['steps +1 ⇒ 有进展', hasProgress(P0, { ...P0, steps: 11 }, S), true],
    ['toolMs +1 ⇒ 有进展', hasProgress(P0, { ...P0, toolMs: 5001 }, S), true],
    ['llmMs +1 ⇒ 有进展', hasProgress(P0, { ...P0, llmMs: 7001 }, S), true],
    ['三者全不动 + 窗口 0（只比数值）⇒ 无进展', hasProgress(P0, { ...P0 }, 0), false],
    ['三者全不动 + 窗口已填满 ⇒ 无进展',
      hasProgress({ ...P0, at: now - 11 * 60e3 }, { ...P0, at: now }, S), false],
    ['三者全不动 + 窗口未填满 ⇒ 不敢判停滞',
      hasProgress({ ...P0, at: now - 60e3 }, { ...P0, at: now }, S), true],
    ['数值退步也绝不能当成"有进展"', hasProgress(P0, { ...P0, steps: 9, toolMs: 4000, llmMs: 6000 }, 0), false],
    ['缺失字段按 0 处理，不抛错、不误判为进展', hasProgress({}, {}, 0), false],
    ['⛔ updatedAt 传进去也不影响判据（旧签名兼容性检查）',
      hasProgress({ ...P0, updatedAt: now }, { ...P0, updatedAt: now - 3600e3 }, 0), false],
  ];
  for (const c of growCases) cases.push(c);
  // ── 催促文案（宿主 2026-11-02 亲自定的三句，必须一字不差地体现）──
  const t1 = nudgeText(1, 10), t2 = nudgeText(2, 20), t3 = nudgeText(3, 30);
  const textCases = [
    ['1 档说的是"进度如何"', /进度如何/.test(t1), true],
    ['1 档不说"比我预期慢"（别指责）', /比我预期慢/.test(t1), false],
    ['2 档说的是"麻烦加快进度"', /麻烦加快进度/.test(t2), true],
    ['3 档要它自评难易度', /难易度/.test(t3), true],
    ['3 档要它估预计时间', /还要多久/.test(t3), true],
    ['3 档要它说已做到哪一步', /已经做到哪一步/.test(t3), true],
    ['⛔ 任何一档都不许说"最小可用版本"', [t1, t2, t3].some((x) => /最小可用/.test(x)), false],
    ['⛔ 任何一档都不许逼它"先交一半/交一部分"', [t1, t2, t3].some((x) => /先交|交一半|覆盖一半|哪怕只/.test(x)), false],
    ['⛔ 任何一档都不许说"别往下铺了"', [t1, t2, t3].some((x) => /别往下铺/.test(x)), false],
    ['⛔ 任何一档都不许说"收口/停止推进"', [t1, t2, t3].some((x) => /收口|停止推进/.test(x)), false],
    ['3 档明确说"长任务我理解"', /长任务我理解/.test(t3), true],
  ];
  for (const c of textCases) cases.push(c);

  // ── 收口闸门（2026-11-09）：纯函数判据，⛔ 必须能失败（拆了就红）──
  const SMIN = 300, SMAX = 1200;
  const D = (s, g, sent) => stopDecision(s, g, sent, SMIN, SMAX);
  cases.push(
    ['收口·默认路径：未绿且未到 20 分 ⇒ 不投', D(900, false, false).due, false],
    ['收口·刚开工 1 分钟且自检绿 ⇒ 不投（防误杀）', D(60, true, false).due, false],
    ['收口·全绿但未过 5 分钟窗口 ⇒ 不投', D(299, true, false).due, false],
    ['收口·全绿且已过 5 分钟 ⇒ 投「验收全绿」', D(300, true, false).reason, '验收全绿'],
    ['收口·未绿但满 20 分钟 ⇒ 仍投「硬上限」', D(1200, false, false).reason, '硬上限'],
    ['收口·硬上限优先于全绿判定', D(1300, true, false).reason, '硬上限'],
    ['收口·已投过 ⇒ 一律不再投', D(3600, true, true).due, false],
    ['收口·停令必须含「停，给结论」', /停，给结论/.test(stopText('验收全绿', 20)), true],
    ['⛔ 停令不许再问进度/自评（t78 放大器）', /进度如何|难易度|还要多久|麻烦加快/.test(stopText('验收全绿', 20) + stopText('硬上限', 20)), false]
  );

  // ══════════════════════════════════════════════════════════════════════
  // 失败计数 / 升级报警的判据（2026-11-02 15:10 加）
  //   ★ 必须抽成纯函数才能断言 —— 这是坑⑱ 的方法论：
  //     "用伪造 state + 跑真进程"是测不出来的，实时快照会盖掉伪造值。
  // ══════════════════════════════════════════════════════════════════════
  const mkState = () => ({});
  const N = 3;
  // 连续失败 3 次 ⇒ 该报警
  let s1 = mkState();
  recordAction(s1, 'X', false, 'e1');
  const afterOne = failingActions(s1).length;
  recordAction(s1, 'X', false, 'e2');
  const afterTwo = failingActions(s1).length;
  recordAction(s1, 'X', false, 'e3');
  const afterThree = failingActions(s1).length;
  // 第 4 次失败 ⇒ 仍然是"该报警"，但 fail 数=4
  recordAction(s1, 'X', false, 'e4');
  const afterFour = s1[FAIL_STATE_KEY].X.fail;
  // 成功一次 ⇒ 立即清零、退出报警
  recordAction(s1, 'X', true);
  const afterRecover = failingActions(s1).length;
  const failAfterRecover = s1[FAIL_STATE_KEY].X.fail;
  const okCount = s1[FAIL_STATE_KEY].X.ok;
  // 两个动作互不干扰
  let s2 = mkState();
  recordAction(s2, 'A', false, 'a');
  recordAction(s2, 'A', false, 'a');
  recordAction(s2, 'A', false, 'a');
  recordAction(s2, 'B', true);
  const twoActs = failingActions(s2).map((x) => x.name).join(',');
  // lastErr 只留最近一次
  let s3 = mkState();
  recordAction(s3, 'Y', false, '第一次');
  recordAction(s3, 'Y', false, '第二次');
  const lastErr = s3[FAIL_STATE_KEY].Y.lastErr;

  const healthCases = [
    ['失败 1 次 ⇒ 还不报警', afterOne, 0],
    ['失败 2 次 ⇒ 还不报警', afterTwo, 0],
    ['失败 3 次 ⇒ 升级报警', afterThree, 1],
    ['失败 4 次 ⇒ 仍报警且计数=4', afterFour, 4],
    ['成功 1 次后 ⇒ 退出报警（自动降级）', afterRecover, 0],
    ['成功 1 次后 ⇒ 失败计数清零', failAfterRecover, 0],
    ['成功要累加 ok 计数（不是只看失败）', okCount, 1],
    ['两个动作互不干扰，只有坏的报警', twoActs, 'A'],
    ['lastErr 只留最近一次错误', lastErr, '第二次'],
  ];
  for (const c of healthCases) cases.push(c);

  // ══════════════════════════════════════════════════════════════════════
  // ★ 三期·收工未回执自动催（宿主：「场景结束后要跟你汇报」）
  //   宿主原话的机器版：**收工那一刻有未回执的派单 ⇒ 必须催它补**。
  //   四条基本盘（命令点名要的）+ 边界，缺一不可。
  // ══════════════════════════════════════════════════════════════════════
  const T0 = 1_000_000_000_000;
  const tk = (o = {}) => ({ ts: '2026-11-02 17:55:41', head: '【派单】Super-agent 三期移植', done: false, archived: false, isSelf: false, ...o });
  const ticketCases = [
    // ── 四条基本盘 ──
    ['收工(true→false) + 有 1 单未回执 ⇒ 催 1 单',
      shouldAskReceipt(true, false, [tk()], {}, T0), 1],
    ['收工 + 全部已回执 ⇒ 不催',
      shouldAskReceipt(true, false, [tk({ done: true })], {}, T0), 0],
    ['收工 + 单子已归档 ⇒ 不催',
      shouldAskReceipt(true, false, [tk({ archived: true })], {}, T0), 0],
    // ★ 命令第 8 单要求：ignored 字段必须真进判据（不是只在台账显示层）
    ['收工 + 单子已登记忽略（命令说"不追"）⇒ 不催',
      shouldAskReceipt(true, false, [tk({ ignored: true })], {}, T0), 0],
    ['忽略单和未回执单混着 ⇒ 只催没忽略那 1 单',
      shouldAskReceipt(true, false, [tk({ ignored: true }), tk({ ts: '2026-11-02 18:50:15', head: 'B' })], {}, T0), 1],
    ['命令自己(isSelf)收工 ⇒ 不催',
      shouldAskReceipt(true, false, [tk({ isSelf: true })], {}, T0), 0],
    // ── 边界：不能漏催，也不能乱催 ──
    ['还在跑(true→true) ⇒ 不催（别打断干活）',
      shouldAskReceipt(true, true, [tk()], {}, T0), 0],
    ['上一轮就没在跑(false→false) ⇒ 不催（不是"收工那一刻"）',
      shouldAskReceipt(false, false, [tk()], {}, T0), 0],
    ['一直空闲(false→false) 连跑十轮也只催 0 单（不刷屏）',
      Array.from({ length: 10 }).reduce((acc) => acc + shouldAskReceipt(false, false, [tk()], {}, T0), 0), 0],
    ['2 单未回执 ⇒ 催 2 单（数得准）',
      shouldAskReceipt(true, false, [tk(), tk({ ts: '2026-11-02 18:50:15', head: '【派单】立规矩' })], {}, T0), 2],
    ['已回执的混在未回执里 ⇒ 只催没回的那 1 单',
      shouldAskReceipt(true, false, [tk(), tk({ ts: '2026-11-02 18:50:15', head: 'B', done: true })], {}, T0), 1],
    ['同一单 30 分钟内催过 ⇒ 不重复催',
      shouldAskReceipt(true, false, [tk()], { receiptAsked: { [openTicketKey(tk())]: T0 - 5 * 60e3 } }, T0), 0],
    ['同一单催过但已过 30 分钟 ⇒ 可以再催',
      shouldAskReceipt(true, false, [tk()], { receiptAsked: { [openTicketKey(tk())]: T0 - 31 * 60e3 } }, T0), 1],
    ['催过的是另一单 ⇒ 这一单照催（冷却按单算，不按会话算）',
      shouldAskReceipt(true, false, [tk()], { receiptAsked: { 'other|x': T0 - 60e3 } }, T0), 1],
    ['没单子 ⇒ 不催', shouldAskReceipt(true, false, [], {}, T0), 0],
    ['单子列表烂数据/null ⇒ 不抛错、不催',
      shouldAskReceipt(true, false, [null, undefined], {}, T0), 0],
    ['没有 state 也能跑（st 省略）⇒ 有未回执就催', shouldAskReceipt(true, false, [tk()], null, T0), 1],
  ];
  for (const c of ticketCases) cases.push(c);

  // ══════════════════════════════════════════════════════════════════════
  // ★ 2026-11-02 23:00 加：**压缩前必须先回暗号**（宿主定的）
  //   这组断言守的是"不经询问就压"这个最贵的错误：
  //   压错一次 = 永久丢信息，比"晚压一会儿"严重得多。所以正反都要打。
  // ══════════════════════════════════════════════════════════════════════
  const oc = (arr) => arr.map((x, i) => ({ turn: i + 1, prompt: x[0] || '', response: x[1] || '' }));
  const askCases = [
    ['没回话 ⇒ 不压（最关键的一条）',
      gotAnswer({ outline: [] }), false],
    ['只问了没答 ⇒ 不压',
      gotAnswer({ outline: oc([['【哨兵·压缩前落盘 · 第 1 次询问】你的上下文已到压缩线', '好的我看看']]) }), false],
    ['回了【已落盘】⇒ 可以压',
      gotAnswer({ outline: oc([['【哨兵·压缩前落盘】…', '【已落盘】']]) }), true],
    ['回了【无需落盘】⇒ 可以压',
      gotAnswer({ outline: oc([['【哨兵·压缩前落盘】…', '【无需落盘】']]) }), true],
    ['⚠ 哨兵提问里含暗号 ⇒ 不算回话（否则闸等于没有）',
      gotAnswer({ outline: oc([['【哨兵·压缩前落盘】…回一句【已落盘】', '好的我去写']]) }), false],
    ['暗号在 response 里才算',
      gotAnswer({ outline: oc([['【哨兵·压缩前落盘】…', '已经写好了 【已落盘】']]) }), true],
    ['很久以前回过、最近 3 轮没回 ⇒ 不压（⛔ 不许拿旧证据当新证据）',
      gotAnswer({ outline: oc([['q', '【无需落盘】'], ['q2', 'x'], ['q3', 'y'], ['q4', 'z']]) }), false],
    ['最近 3 轮里回过 ⇒ 可以压',
      gotAnswer({ outline: oc([['q', '【无需落盘】'], ['q2', 'x'], ['q3', 'y']]) }), true],
    ['outline 是脏数据/null ⇒ 不压、不抛',
      gotAnswer({ outline: null }), false],
    ['传 null 也不抛', gotAnswer(null), false],
    ['暗号必须一字不差（「已落盘」没方括号 ⇒ 不算）',
      gotAnswer({ outline: oc([['q', '已落盘']]) }), false],
    // ── ★ 2026-11-03 10:40：**上一次的回答不许当这一次的**（宿主：「判据要比关系」）──
    ['⛔ 上次回过【已落盘】、这次提问之后还没回 ⇒ 不算（否则闸凭空放行）',
      gotAnswer({ outline: [{ turn: 1, seq: 100, prompt: '上上次', response: '【已落盘】' },
        { turn: 2, seq: 200, prompt: '【哨兵·压缩前落盘】这次问', response: '' }] }, 200), false],
    ['这次提问之后真回了【已落盘】⇒ 算',
      gotAnswer({ outline: [{ turn: 1, seq: 100, prompt: '上上次', response: '【已落盘】' },
        { turn: 2, seq: 200, prompt: '这次问', response: '' },
        { turn: 3, seq: 300, prompt: 'x', response: '【已落盘】' }] }, 200), true],
    ['没给 minSeq 时退回"最近 3 轮"（兼容老 state）',
      gotAnswer({ outline: [{ turn: 1, seq: 100, prompt: 'q', response: '【已落盘】' }] }), true],
    ['minSeq 比所有轮次都新 ⇒ 不算（问完之后一个字都没回）',
      gotAnswer({ outline: [{ turn: 1, seq: 100, prompt: 'q', response: '【无需落盘】' }] }, 999), false],
    ['answerTagOf 带 minSeq 只认之后的轮次',
      answerTagOf({ outline: [{ turn: 1, seq: 100, prompt: 'q', response: '【已落盘】' },
        { turn: 2, seq: 200, prompt: 'q2', response: '【无需落盘】' }] }, 150), '【无需落盘】'],
    ['lastOutlineSeq 取最大 seq（读不到给 0）',
      lastOutlineSeq({ outline: [{ seq: 5 }, { seq: 9 }, { seq: 7 }] }), 9],
    ['lastOutlineSeq 脏数据 ⇒ 0（不抛）', lastOutlineSeq(null), 0],
  ];
  // ★ answeredThisAsk 那组用例的"提问时刻"（一个固定常数，避免每条都写字面量）
  const ASK_T = 1_700_000_000_000;
  const askCases2 = [
    // ── ★★ answeredThisAsk：这一次提问之后的回答才算（整条闸的地基）──
    //   ⚠ 2026-11-03 16:45 起，**每条正例都必须带 askAt**（本轮真问过）——
    //     没有 askAt 就是"没问过"，一律判没回（这是 16:29 那次事故的根因，见函数注释）。
    ['⛔ 上次回过【已落盘】、这次问完还没回 ⇒ 不算（否则闸凭空放行）',
      answeredThisAsk({ outline: [{ seq: 100, prompt: '旧的', response: '【已落盘】' },
        { seq: 200, prompt: '【哨兵·压缩前落盘】这次问', response: '' }] },
        { askAt: ASK_T, askSeq: 200, askResp: '' }), ''],
    ['这次问完真回了【已落盘】⇒ 算',
      answeredThisAsk({ outline: [{ seq: 200, prompt: '这次问', response: '' },
        { seq: 300, prompt: 'x', response: '【已落盘】' }] },
        { askAt: ASK_T, askSeq: 200, askResp: '' }), '【已落盘】'],
    ['★ steer 落在同一轮：seq 相等但 response 从空变成【已落盘】⇒ 算（死抠 > 会永远压不了）',
      answeredThisAsk({ outline: [{ seq: 200, prompt: '这次问', response: '【已落盘】' }] },
        { askAt: ASK_T, askSeq: 200, askResp: '' }), '【已落盘】'],
    ['同一轮 seq 相等、response 没变过 ⇒ 不算',
      answeredThisAsk({ outline: [{ seq: 200, prompt: '这次问', response: '好的' }] },
        { askAt: ASK_T, askSeq: 200, askResp: '好的' }), ''],
    ['⛔ 老 state 没有 askSeq ⇒ 一律当"没回"（不知道基准，不许开闸）',
      answeredThisAsk({ outline: [{ seq: 300, prompt: 'q', response: '【无需落盘】' }] },
        { askAt: ASK_T }), ''],
    ['这次回的是【无需落盘】⇒ 认得出',
      answeredThisAsk({ outline: [{ seq: 300, prompt: 'q', response: '【无需落盘】' }] },
        { askAt: ASK_T, askSeq: 200, askResp: '' }), '【无需落盘】'],
    ['⭐ 回归：上一次【已落盘】+ 这次【无需落盘】⇒ 取这次的（不能因为更早那条就误判）',
      answeredThisAsk({ outline: [{ seq: 100, prompt: '旧', response: '【已落盘】' },
        { seq: 300, prompt: '这次', response: '【无需落盘】' }] },
        { askAt: ASK_T, askSeq: 200, askResp: '' }), '【无需落盘】'],
    ['脏数据 ⇒ 空串、不抛', answeredThisAsk(null, null), ''],
    ['askResp 是脏数据也按空串比',
      answeredThisAsk({ outline: [{ seq: 200, response: '【已落盘】' }] },
        { askAt: ASK_T, askSeq: 200, askResp: undefined }), '【已落盘】'],

    // ══════════════════════════════════════════════════════════════════════
    // ★★ 2026-11-03 16:45 · 针对 16:29 那次事故的**原样复现**（宿主第二次问「怎么没问就压」）
    //   这一组是本次修 bug 的验收样本，缺一条这个 bug 就可能还在。
    // ══════════════════════════════════════════════════════════════════════
    ['🔥 事故原样复现：askAt=0/askedN=0 但残留 askSeq=4044，8 小时前回过【已落盘】⇒ 必须判"没回"',
      answeredThisAsk({ outline: [
        { seq: 4040, prompt: '07:5x 的活', response: '【已落盘】' },      // 第 21 轮，08:0x 回的那句
        { seq: 4200, prompt: '后来的活', response: '收尾已完成。 ## 一、这一轮先做好的事：记忆瘦身' },
        { seq: 4300, prompt: 'x', response: 'y' },
        { seq: 4400, prompt: 'z', response: 'w' },
      ] }, { askAt: 0, askedN: 0, askSeq: 4044, askResp: '收尾已完成。' }), ''],
    ['🔥 askAt=0（没问过）+ 最近一轮刚回【已落盘】⇒ 也必须判"没回"（没问就回，不是回答我）',
      answeredThisAsk({ outline: [{ seq: 500, prompt: '刚干完', response: '【已落盘】' }] },
        { askAt: 0, askedN: 0, askSeq: 0 }), ''],
    ['✅ 正样本：askAt=now + askSeq=100，第 101 轮回【已落盘】⇒ 判回了',
      answeredThisAsk({ outline: [{ seq: 100, prompt: '问', response: '' },
        { seq: 101, prompt: 'x', response: '【已落盘】' }] },
        { askAt: ASK_T, askedN: 1, askSeq: 100, askResp: '' }), '【已落盘】'],
    ['🔥 防回归（反方向）：askAt=now + askSeq=100，第 150~160 轮之间回【已落盘】，之后又跑 50 轮 ⇒ 仍要判"回了"',
      answeredThisAsk({ outline: [
        { seq: 100, prompt: '问', response: '' },
        ...Array.from({ length: 49 }, (_, i) => ({ seq: 101 + i, prompt: '干', response: '普通回答' })),  // 101..149
        { seq: 155, prompt: 'x', response: '【已落盘】' },                                              // 150~160 之间
        ...Array.from({ length: 50 }, (_, i) => ({ seq: 200 + i, prompt: '继续干', response: '普通回答' })), // 之后又 50 轮
      ] }, { askAt: ASK_T, askedN: 1, askSeq: 100, askResp: '' }), '【已落盘】'],
    ['★ 静态断言：answeredThisAsk 里不许再出现按条数截断的 .slice(-n)（快照判据，会随会话变长而变）',
      (() => {
        // ⚠ 同理：按行首锚定真定义，别被自测里的样例字符串骗了
        const m = selfSrc.match(/^function answeredThisAsk\(/m);
        if (!m) return 'no-fn';
        const body = selfSrc.slice(m.index, selfSrc.indexOf('\n}', m.index) + 2);
        // ⚠ 必须**连行尾注释一起剥**：本函数体里有一行 `// ⛔ 不再 .slice(-8)：…` 是解释性注释，
        //   不剥就会被正则当成"代码里还在用 slice(-8)" ⇒ 假红。
        //   （和 09:xx 那次 pickCost 的假红是同一个坑：注释引用了旧写法。）
        // ⚠ 剥注释用 `[^\r\n]*` 而不是 `.*$`：本文件是 **CRLF**，`.` 不匹配 `\r`、`$` 又要求串尾
        //   ⇒ `.*$` 在这种行上**一条都匹配不到**（第一版就是这么假红的）。
        const code = body.split('\n')
          .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
          .map((l) => l.replace(/\/\/[^\r\n]*/g, ''))
          .join('\n');
        return /\.slice\(\s*-\s*\d+\s*\)/.test(code) ? 'has-slice' : 'clean';
      })(), 'clean'],
    ['★ 静态断言：answeredThisAsk 必须先看 askAt（没问过就不认暗号）',
      (() => {
        // ⚠ 不能用 selfSrc.indexOf('function answeredThisAsk(')：本自测自己就含这串字面量
        //   （和 countCompactCallSites 踩的是同一个坑）⇒ 会定位到 case 文本而不是真函数。
        //   ⇒ 按**行首**锚定取真定义。
        const m = selfSrc.match(/^function answeredThisAsk\(/m);
        if (!m) return 'no-fn';
        const body = selfSrc.slice(m.index, m.index + 600);
        return /const\s+askAt\s*=\s*Number\(st\s*&&\s*st\.askAt\)/.test(body) && /if\s*\(!askAt\)\s*return/.test(body)
          ? 'guarded' : 'unguarded';
      })(), 'guarded'],
    ['★★ 静态断言：压缩成功后的 state 重置必须清掉 askSeq / askResp（16:29 事故的第 2 个根因）',
      (() => {
        // ⚠ 判定改为**关系**而不是字面量：
        //   旧写法去找 `askSeq: 0` 字面量 ⇒ 一旦重构成 `...askResetPatch()` 就假红
        //   （这正是"判据不能描述快照"的又一次翻车）。
        //   现在判两件事：① 生产代码里那个重置点**调用**了 askResetPatch()
        //              ② askResetPatch() 真的清了 askSeq/askResp（真跑一遍函数，不看文本）
        const i = selfSrc.lastIndexOf('compactCost: after2');
        if (i < 0) return 'no-reset';
        const seg = selfSrc.slice(i, i + 1200);
        const callsPatch = /\.\.\.askResetPatch\(\)/.test(seg);
        const p = askResetPatch();
        const clears = p.askSeq === 0 && p.askResp === '';
        return (callsPatch && clears) ? 'cleared' : ('anchor-left(callsPatch=' + callsPatch + ',clears=' + clears + ')');
      })(), 'cleared'],
    ['★★ 静态断言：B③ 进验证闸前必须硬条件 askAt>0 && askedN>0（没问过就不许开闸）',
      (() => {
        const i = selfSrc.lastIndexOf('const askedThisRound =');
        if (i < 0) return 'no-guard';
        const seg = selfSrc.slice(i, i + 400);
        return /askAt\s*>\s*0\s*&&\s*askedN\s*>\s*0/.test(seg) ? 'guarded' : 'unguarded';
      })(), 'guarded'],
    ['★★ 静态断言：第 1.5 段验证闸之前，ANSWERED 必须受 askedThisRound 约束',
      (() => {
        const i = selfSrc.lastIndexOf('const ANSWERED =');
        if (i < 0) return 'no-answered';
        const seg = selfSrc.slice(i, i + 200);
        return /ANSWERED\s*=\s*askedThisRound\s*\?/.test(seg) ? 'guarded' : 'unguarded';
      })(), 'guarded'],
    // ══════════════════════════════════════════════════════════════════════
    // ★★ 单实例锁（派单第 ④ 条）：正反样本都打
    // ══════════════════════════════════════════════════════════════════════
    ['🔒 锁：没人持锁 ⇒ 能拿', lockState({ raw: '', pidAliveFn: () => true }).ok, true],
    ['🔒 锁：持锁 pid 还活着 ⇒ **不能拿**（已经有哨兵在跑）',
      lockState({ raw: '1234|' + 1e12, pidAliveFn: () => true }).ok, false],
    ['🔒 锁：持锁 pid 已死（崩溃残留）⇒ 能拿（接管）',
      lockState({ raw: '1234|' + 1e12, pidAliveFn: () => false }).ok, true],
    ['🔒 锁：脏数据 ⇒ 当没人持锁（能拿），不许被垃圾锁卡死',
      lockState({ raw: 'garbage', pidAliveFn: () => true }).ok, true],
    ['🔒 锁：pid=0 ⇒ 当没人持锁', lockState({ raw: '0|' + 1e12, pidAliveFn: () => true }).ok, true],
    ['🔒 parseLock 正常解析', JSON.stringify(parseLock('456|' + 1e12)), JSON.stringify({ pid: 456, at: 1e12 })],
    ['🔒 parseLock 脏数据 ⇒ null', parseLock('abc'), null],
    ['🔒 pidAlive 对自己 ⇒ true（真 pid 探测）', pidAlive(process.pid), true],
    ['🔒 pidAlive 对不可能的 pid ⇒ false', pidAlive(999999), false],
    // ★★ 2026-11-08 · EPERM 误判回归闸（本单根因：本机 `process.kill(死 pid,0)` 也抛 EPERM）
    //   两条正反样本都走真实 pidAlive，只把两个来源注入成确定值：
    //     ① EPERM + 第二来源(tasklist)查死 ⇒ 锁是残留、**能拿**（哨兵不在岗才敢接）
    //     ② EPERM + 第二来源查活           ⇒ **拿不到**（真有权限不足的活实例时不许抢锁）
    ['🩺 EPERM + 复核查死 ⇒ 不在岗 ⇒ 残留锁**能拿**（旧实现会永久锁死哨兵）',
      lockState({ raw: '6952|' + 1e12,
        pidAliveFn: (p) => pidAlive(p, { killProbe: () => 'eperm', listProbe: () => false }) }).ok, true],
    ['🩺 EPERM + 复核查活 ⇒ 在岗 ⇒ 锁**拿不到**（不许抢活实例的锁）',
      lockState({ raw: '6952|' + 1e12,
        pidAliveFn: (p) => pidAlive(p, { killProbe: () => 'eperm', listProbe: () => true }) }).ok, false],
    ['★ 静态：本文件不许再自己定义 pidAlive / 不许内联「EPERM ⇒ 活着」（三份抄写必有一份写反）',
      (function () {
        if (/^function pidAlive\(/m.test(selfSrc)) return 'OWN-PIDALIVE';
        // ⚠ ⛔ 不能把这个判断（code 等于 EPERM）写成字面量 —— 断言自己就含那串 ⇒ 恒红。
        if (new RegExp("code === 'EP" + "ERM'\\)").test(selfSrc)) return 'INLINE-EPERM';
        return 'shared-only';
      })(), 'shared-only'],
    ['★★ 静态断言：哨兵启动路径必须有单实例锁（拿不到就干净退出）',
      (() => {
        const i = selfSrc.lastIndexOf('takeLock(LOCK_FILE)');
        if (i < 0) return 'no-lock';
        const seg = selfSrc.slice(i, i + 1200);
        return /if\s*\(!lk\.ok\)/.test(seg) && /return\s+0/.test(seg) ? 'guarded' : 'unguarded';
      })(), 'guarded'],
    ['★★ 静态断言：干跑不许占锁（否则干跑会把真哨兵挡在门外）',
      /if\s*\(\s*WATCH\s*&&\s*!DRYRUN\s*\)/.test(selfSrc) ? 'guarded' : 'unguarded', 'guarded'],
    // ══════════════════════════════════════════════════════════════════════
    // ★★ askTagFrom（派单第 ③ 条点名要的字段）：正反样本都打
    // ══════════════════════════════════════════════════════════════════════
    ['🏷️ tagStateAt：提问之前就有【已落盘】⇒ 记下它',
      tagStateAt([{ seq: 50, response: '【已落盘】' }, { seq: 100, response: '干完了' }], 100), '【已落盘】'],
    ['🏷️ tagStateAt：提问之前没有暗号 ⇒ 记空串',
      tagStateAt([{ seq: 50, response: '普通回答' }], 100), ''],
    ['🏷️ tagStateAt：只看提问之前的轮次（seq > 基准的不算）',
      tagStateAt([{ seq: 50, response: '普通' }, { seq: 200, response: '【已落盘】' }], 100), ''],
    ['🏷️ tagStateAt：脏数据 ⇒ 空串、不抛', tagStateAt(null, 100), ''],
    // ★ 2026-11-04 22:32：断言跟着判据改 —— 老语义「比暗号字面」已被证伪（同场景每次都回同一个暗号，
    //   字面必然相同 ⇒ 恒判"旧暗号复用" ⇒ 死锁）。现语义「比轮次」：只有命中轮次 ≤ 提问前最后暗号轮次才算复用。
    ['🏷️ 轮次判据：命中轮次 = 提问前最后暗号轮次 ⇒ 判复用（不算回了）',
      answeredThisAsk({ outline: [{ seq: 100, prompt: '问', response: '【已落盘】' }] },
        { askAt: ASK_T, askedN: 1, askSeq: 100, askResp: '', askTagSeq: 100 }), ''],
    ['🏷️ 轮次判据：命中轮次 > 提问前最后暗号轮次 ⇒ 算回了（这正是 22:15 死锁的正解）',
      answeredThisAsk({ outline: [{ seq: 9188, prompt: '旧问', response: '【已落盘】' },
        { seq: 11015, prompt: '本次问', response: '【已落盘】' }] },
        { askAt: ASK_T, askedN: 1, askSeq: 11015, askResp: '', askTagSeq: 9188 }), '【已落盘】'],
    ['🏷️ 轮次判据：老 state 无 askTagSeq ⇒ 不比字面（防死锁复发）',
      answeredThisAsk({ outline: [{ seq: 9188, prompt: '旧', response: '【已落盘】' },
        { seq: 11015, prompt: '本次', response: '【已落盘】' }] },
        { askAt: ASK_T, askedN: 1, askSeq: 11015, askResp: '', askTagFrom: '【已落盘】' }), '【已落盘】'],
    ['🏷️ askTagFrom 不误伤：提问前是【已落盘】，这次回的是【无需落盘】⇒ 算回了',
      answeredThisAsk({ outline: [{ seq: 100, prompt: '问', response: '' },
        { seq: 101, prompt: 'x', response: '【无需落盘】' }] },
        { askAt: ASK_T, askedN: 1, askSeq: 100, askResp: '', askTagFrom: '【已落盘】' }), '【无需落盘】'],
    ['🏷️ askTagFrom 为空（老 state）⇒ 不影响判定',
      answeredThisAsk({ outline: [{ seq: 100, prompt: '问', response: '' },
        { seq: 101, prompt: 'x', response: '【已落盘】' }] },
        { askAt: ASK_T, askedN: 1, askSeq: 100, askResp: '' }), '【已落盘】'],
    ['🏷️ askTagFrom 为空 + 同一轮补上回答 ⇒ 算回了（老 state 不会被 askTagFrom 误伤）',
      answeredThisAsk({ outline: [{ seq: 100, prompt: '问', response: '【已落盘】' }] },
        { askAt: ASK_T, askedN: 1, askSeq: 100, askResp: '' }), '【已落盘】'],

    // ══════════════════════════════════════════════════════════════════════
    // ★★ 2026-11-04 22:18 · 修「askResp 被上一轮回答污染 ⇒ 永不压缩」的死锁
    //    现场：工作台改造 会话 bad2f7eb… 21:55 问第1次、21:56 回【已落盘】、
    //          22:07 又问第2次 —— 因为 askResp 记成了 turn65 的『回答』而不是『提问前的值』。
    // ══════════════════════════════════════════════════════════════════════
    ['🔒 respBeforeAsk：询问轮那一轮**不算**基线（这正是死锁的根源）',
      respBeforeAsk([{ seq: 100, response: '上个回答' }, { seq: 11015, response: '【已落盘】' }], 11015), '上个回答'],
    ['🔒 respBeforeAsk：取 seq < askSeq 里最靠后那一轮的 response',
      respBeforeAsk([{ seq: 50, response: 'A' }, { seq: 100, response: 'B' }, { seq: 200, response: 'C' }], 200), 'B'],
    ['🔒 respBeforeAsk：前面没有任何轮 ⇒ 空串（不是"已有暗号"）',
      respBeforeAsk([{ seq: 300, response: '【已落盘】' }], 300), ''],
    ['🔒 respBeforeAsk：脏数据 ⇒ 空串、不抛', respBeforeAsk(null, 100), ''],
    ['🔒 respBeforeAsk：askSeq=0 ⇒ 空串', respBeforeAsk([{ seq: 5, response: 'x' }], 0), ''],
    // ★ 回归：真实死锁场景 —— 提问轮被补进回答，必须认得出来
    ['🔒★ 回归·死锁：askResp 取对了（提问前为空），询问轮被补进【已落盘】⇒ 必须认得出',
      answeredThisAsk({ outline: [
        { seq: 11007, prompt: '上一轮', response: '' },
        { seq: 11015, prompt: '【哨兵·压缩前落盘 · 第 1 次询问】', response: '【已落盘】' },
      ] }, { askAt: ASK_T, askedN: 1, askSeq: 11015, askResp: respBeforeAsk([{ seq: 11007, response: '' }, { seq: 11015, response: '【已落盘】' }], 11015), askTagFrom: tagStateAt([{ seq: 11007, response: '' }, { seq: 11015, response: '【已落盘】' }], 11015) }), '【已落盘】'],
    ['🔒★ 回归·旧写法必红：基线错取成询问轮的回答 ⇒ 认不出（证明这条断言真能抓 bug）',
      answeredThisAsk({ outline: [{ seq: 11015, prompt: '询问', response: '【已落盘】' }] },
        { askAt: ASK_T, askedN: 1, askSeq: 11015, askResp: '【已落盘】', askTagFrom: '【已落盘】' }), ''],
    ['🔒★ 压缩成功时必须把 askCycleAt 一起清零（留半截会咬人 —— 3008 行的教训）',
      /askCycleAt: 0/.test(selfSrc), true],
    ['🔒 tagStateAt 修后：询问轮自己被补进暗号 ⇒ 不算"提问前已有"',
      tagStateAt([{ seq: 100, response: '普通' }, { seq: 200, response: '【已落盘】' }], 200), ''],
    ['lastOutlineTurn 连带 response 一起取（同一轮补回答时要用）',
      JSON.stringify(lastOutlineTurn({ outline: [{ seq: 5, response: 'a' }, { seq: 9, response: 'b' }] })),
      JSON.stringify({ seq: 9, response: 'b' })],
  ];
  for (const c of askCases) cases.push(c);
  for (const c of askCases2) cases.push(c);

  // ══════════════════════════════════════════════════════════════════════
  // ★ 2026-11-03 10:30 加：**压缩前验证闸**（宿主：「需要过一遍验证闸」）
  //   这组守的是"回了暗号就能压"这个错觉 —— 光有暗号不算，还得真有东西落下去。
  //   正反都打：反例必须被拦（否则闸等于没有），正例必须放行（否则永远压不了）。
  // ══════════════════════════════════════════════════════════════════════
  const D0 = { count: 3, maxMtime: 1000, names: ['01_a.md'] };
  const gateCases = [
    // ── 反例：必须拦 ──
    ['⛔ 没回暗号 ⇒ 拦', compactGateVerdict({ tag: '', diskChanged: true, healthBad: 0 }).allow, false],
    ['⛔ 回了「已落盘」但文档一个字没动 ⇒ 拦（这是"假落盘"）',
      compactGateVerdict({ tag: '【已落盘】', diskChanged: false, healthBad: 0 }).allow, false],
    ['⛔ 回了「已落盘」、文档也动了，但体检有违规 ⇒ 拦',
      compactGateVerdict({ tag: '【已落盘】', diskChanged: true, healthBad: 2 }).allow, false],
    ['⛔ 体检跑不起来（-1）⇒ 按拦处理（fail closed，不许假绿）',
      compactGateVerdict({ tag: '【已落盘】', diskChanged: true, healthBad: -1 }).allow, false],
    // ── 正例：必须放行 ──
    ['回了「无需落盘」⇒ 放行（它自己说没有，我不替它猜）',
      compactGateVerdict({ tag: '【无需落盘】', diskChanged: false, healthBad: 0 }).allow, true],
    ['回了「已落盘」+ 文档真变了 + 体检 0 违规 ⇒ 放行',
      compactGateVerdict({ tag: '【已落盘】', diskChanged: true, healthBad: 0 }).allow, true],
    ['「无需落盘」不要求 diskChanged（不能拿体检去拦一个说没有的人）',
      compactGateVerdict({ tag: '【无需落盘】', diskChanged: false, healthBad: 9 }).allow, true],
    // ── 快照 vs 关系：昨天建的文档不能让今天的闸变绿 ──
    ['⛔ 提问前后快照完全相同（旧文档还在）⇒ 不算落盘',
      diskChangedSinceAsk(D0, { count: 3, maxMtime: 1000, names: ['01_a.md'] }), false],
    ['提问后新增了一篇 ⇒ 算落盘',
      diskChangedSinceAsk(D0, { count: 4, maxMtime: 1000, names: ['01_a.md', '02_b.md'] }), true],
    ['提问后篇数没变但有一篇被改（mtime 前进）⇒ 算落盘',
      diskChangedSinceAsk(D0, { count: 3, maxMtime: 2000, names: ['01_a.md'] }), true],
    ['提问时没有快照（老 state）⇒ 不算落盘（宁可拦一次，不许假绿）',
      diskChangedSinceAsk(null, { count: 4, maxMtime: 3000, names: [] }), false],
    // ══════════════════════════════════════════════════════════════════════
    // ★★★ 2026-11-04 23:05 · 第三个死锁：**重问会把基线重拍** ★★★
    //   病根：第 1 次询问拍基线 → 它照着写了文档 → 第 2 次询问**又拍一次**（把刚写的吃进去）
    //         ⇒ count/maxMtime 全相等 ⇒ 闸永久 false ⇒ 每 10 分钟重问 ⇒ 涨到爆。
    //   修法：判据从「快照差」改成「周期起点之后落过盘没有」（时间关系，重问天然免疫）。
    // ══════════════════════════════════════════════════════════════════════
    ['🔒★ 周期起点之后落过盘 ⇒ 算落盘（哪怕基线里已经有那篇）',
      diskChangedSinceAsk(D0, { count: 3, maxMtime: 5000, names: ['01_a.md'] }, 4000), true],
    ['🔒★ 周期起点之后没落过盘（文档都在起点之前）⇒ 不算落盘',
      diskChangedSinceAsk(D0, { count: 3, maxMtime: 3000, names: ['01_a.md'] }, 4000), false],
    ['🔒★ 重问那份被重拍过的基线也不影响：只要 maxMtime > cycleAt 就放行（这就是修死锁的点）',
      diskChangedSinceAsk({ count: 17, maxMtime: 1793803608168 }, { count: 17, maxMtime: 1793803608168 }, 1793803200000), true],
    ['🔒★ 对照·老写法在这里必红：同样的输入不给 cycleAt ⇒ 快照相同 ⇒ 判没落盘（证明修的是真 bug）',
      diskChangedSinceAsk({ count: 17, maxMtime: 1793803608168 }, { count: 17, maxMtime: 1793803608168 }), false],
    ['🔒 askCycleBase：第一次询问 ⇒ 用 now 当起点',
      askCycleBase({}, 11111), 11111],
    ['🔒★ askCycleBase：重问 ⇒ **不更新**起点（这是防死锁的关键）',
      askCycleBase({ askCycleAt: 11111 }, 99999), 11111],
    ['🔒 askCycleBase：老 state 没这个字段 ⇒ 用 now',
      askCycleBase({ askAt: 5 }, 22222), 22222],
    ['🔒★ askDocsBase：第一次询问（askedN=0）⇒ 拍新快照',
      JSON.stringify(askDocsBase({}, 0, { count: 7, maxMtime: 1, names: [] })),
      JSON.stringify({ count: 7, maxMtime: 1, names: [] })],
    ['🔒★ askDocsBase：重问（askedN>0）⇒ **保留旧基线**，不许重拍（否则把它照做的落盘吃进去）',
      JSON.stringify(askDocsBase({ askDocs: { count: 3, maxMtime: 100, names: [] } }, 1, { count: 17, maxMtime: 999, names: [] })),
      JSON.stringify({ count: 3, maxMtime: 100, names: [] })],
    ['🔒 askDocsBase：askedN>0 但老 state 没基线 ⇒ 退而拍新的（不能返回 null 把闸焊死）',
      JSON.stringify(askDocsBase({ askDocs: null }, 2, { count: 4, maxMtime: 5, names: [] })),
      JSON.stringify({ count: 4, maxMtime: 5, names: [] })],
    // ── 老 state 自愈（本轮新字段 askCycleAt 之前产生的 state）──
    ['🔧★ 老 state 问过 2 次却无 askCycleAt ⇒ 判「要重开周期」（基线已被重污染）',
      legacyAskNeedsReset({ askAt: 1000, askedN: 2, askDocs: { count: 17, maxMtime: 9 } }), true],
    ['🔧★ 老 state 只问过 1 次 ⇒ **不重开**（那一次就是干净起点，基线可信）',
      legacyAskNeedsReset({ askAt: 1000, askedN: 1, askDocs: { count: 17, maxMtime: 9 } }), false],
    ['🔧 新 state 有 askCycleAt ⇒ 永不重开（哪怕 askedN=3）',
      legacyAskNeedsReset({ askAt: 1000, askedN: 3, askCycleAt: 2000 }), false],
    ['🔧 没问过 ⇒ 不重开（该正常询问，不是迁移）',
      legacyAskNeedsReset({ askAt: 0, askedN: 0 }), false],
    ['🔧 脏数据 ⇒ 不重开、不抛',
      legacyAskNeedsReset(null), false],
    // ── askResetPatch：周期结束必须清干净（迁移处/压缩处共用，防"有一处漏字段"）──
    ['🧹★ askResetPatch 必须清 askDocs（留脏基线 = 重开周期白开）',
      Object.prototype.hasOwnProperty.call(askResetPatch(), 'askDocs') && askResetPatch().askDocs === null, true],
    ['🧹★ askResetPatch 必须清 askCycleAt（留半截会咬人）',
      Object.prototype.hasOwnProperty.call(askResetPatch(), 'askCycleAt') && askResetPatch().askCycleAt === 0, true],
    ['🧹 askResetPatch 必须清 askAt/askedN/askSeq/askResp/askTagFrom/askTagSeq/gateBlocked 全部',
      ['askAt', 'askedN', 'askSeq', 'askResp', 'askTagFrom', 'askTagSeq', 'gateBlockedAt', 'gateBlockedWhy']
        .every((k) => Object.prototype.hasOwnProperty.call(askResetPatch(), k)), true],
    // ⚠ 按**位置**判，不数全局次数 —— 数次数会把断言自己/注释算进去（本轮已踩）
    ['🧹★ 迁移处必须调用 askResetPatch（位置关系判据，⛔ 不用数次数——踩过两次）',
      (() => {
        const k = selfSrc.lastIndexOf('if (legacyAskNeedsReset(st)) {');
        if (k < 0) return 'no-migrate';
        return /\.\.\.askResetPatch\(\)/.test(selfSrc.slice(k, k + 600)) ? 'ok' : 'missing';
      })(), 'ok'],
    ['🧹★ 压缩成功处必须调用 askResetPatch（同样位置关系判据）',
      (() => {
        const k = selfSrc.lastIndexOf('compactCost: after2');
        if (k < 0) return 'no-reset';
        return /\.\.\.askResetPatch\(\)/.test(selfSrc.slice(k, k + 1200)) ? 'ok' : 'missing';
      })(), 'ok'],
    ['🧹★ 压缩成功处调用了 askResetPatch',
      (() => {
        const i = selfSrc.lastIndexOf('compactCost: after2');
        if (i < 0) return 'no-reset';
        return /\.\.\.askResetPatch\(\)/.test(selfSrc.slice(i, i + 1200)) ? 'ok' : 'missing';
      })(), 'ok'],
    // ── 暗号识别：两个都出现过要以**后出现的**为准 ──
    ['只回【无需落盘】⇒ 认得出', answerTagOf({ outline: oc([['q', '【无需落盘】']]) }), '【无需落盘】'],
    ['只回【已落盘】⇒ 认得出', answerTagOf({ outline: oc([['q', '【已落盘】']]) }), '【已落盘】'],
    ['先【已落盘】后【无需落盘】⇒ 以后者为准',
      answerTagOf({ outline: oc([['q', '【已落盘】'], ['q2', '【无需落盘】']]) }), '【无需落盘】'],
    ['⛔ 暗号只写在 prompt 里（哨兵自己的提问）⇒ 不算回话',
      answerTagOf({ outline: oc([['回一句【已落盘】', '好的']]) }), ''],
    ['outline 是脏数据 ⇒ 返回空串、不抛', answerTagOf({ outline: null }), ''],
    ['传 null 也不抛', answerTagOf(null), ''],
    // ── 体检计数：只数本场景，⛔ 不许被别的场景连坐，⛔ 认不出场景不许放行 ──
    ['体检：程序开发 0 违规 ⇒ 0',
      countBadFor([{ level: 'bad', where: '工作台改造 / X' }, { level: 'warn', where: '程序开发（场景根）' }], '程序开发'), 0],
    ['⛔ 别的场景有违规不许连坐（程序开发仍 0）',
      countBadFor([{ level: 'bad', where: '工作台改造 / X' }], '程序开发'), 0],
    ['本场景有 1 条违规 ⇒ 1（闸必须能红）',
      countBadFor([{ level: 'bad', where: '程序开发（场景根）' }], '程序开发'), 1],
    ['⚠ 提醒(warn)不算违规 ⇒ 0',
      countBadFor([{ level: 'warn', where: '程序开发（场景根）' }], '程序开发'), 0],
    ['⛔ 认不出场景 ⇒ -1（fail closed，不许拿空串 includes 恒真混过去）',
      countBadFor([{ level: 'bad', where: '程序开发' }], ''), -1],
    ['issues 是脏数据 ⇒ 不抛，得 0',
      countBadFor(null, '程序开发'), 0],
  ];
  for (const c of gateCases) cases.push(c);

  // ══════════════════════════════════════════════════════════════════════
  // ★ 2026-11-03 07:55 加：**收尾线不许挡住压缩线**（宿主问「哨兵怎么没问你」的根因）
  //   昨天把 COST_WARN 从 180k 改成 240k（= COST_COMPACT）⇒ hitWind 在压缩线成立 ⇒
  //   收尾分支推完 continue ⇒ B③ 的询问永远走不到。
  //   下面这条断言守的就是"两条线不许相等"。
  // ══════════════════════════════════════════════════════════════════════
  const lineCases = [
    ['⛔ 收尾线必须严格小于压缩线（相等会让询问永远触发不了）',
      COST_WARN < COST_COMPACT, true],
    ['压缩线应是窗口的 80%（宪法 §11）',
      Math.abs(COST_COMPACT / 300000 - 0.8) < 0.01, true],
    ['收尾线不超过压缩线',
      COST_WARN <= COST_COMPACT, true],
  ];
  for (const c of lineCases) cases.push(c);

  // ══════════════════════════════════════════════════════════════════════
  // ★★ 2026-11-03 11:05 加：**先压缩，压不动才交接**（宿主原话）
  //   这组守的是"最贵的分叉"：换人 vs 压缩。判错一次的代价 = 白换一个会话 + 上下文全丢。
  //   老判据 `overRatio && compactedEver` 把"压过"当"压不动"，又因为 B① 排在 B③ 前面
  //   ⇒ 到线就被交接，`/compact` 永远轮不到 ⇒ 宿主说的"先压缩"**在代码里不可能发生**。
  // ══════════════════════════════════════════════════════════════════════
  const G = 1.0, W = 300000;      // 交接线 = 窗口 100%
  const handCases = [
    // ── 反例：到线但**没压过** ⇒ 必须先去压，⛔ 不许交接 ──
    ['⛔ 到交接线但一次都没压过 ⇒ 先压缩（不许交接）',
      handoverOrCompress({ cost: 300000, win: W, gateRatio: G, compactAt: 0 }).action, 'compress-first'],
    ['⛔ 到线、压过、但**上次压完确实降了** ⇒ 还要再压，不许交接',
      handoverOrCompress({ cost: 300000, win: W, gateRatio: G, compactAt: 1, compactIneffective: false }).action, 'compress-first'],
    ['⛔ 压过但没记"没用"（老 state 没这个字段）⇒ 当"还能压"，先压',
      handoverOrCompress({ cost: 320000, win: W, gateRatio: G, compactAt: 1 }).action, 'compress-first'],
    // ── 正例：到线 + 压过 + 实测没用 ⇒ 才交接 ──
    ['✓ 到线 + 压过 + 上次实测没降 ⇒ 才允许交接',
      handoverOrCompress({ cost: 300000, win: W, gateRatio: G, compactAt: 1, compactIneffective: true }).action, 'handover'],
    // ── 没到线 ⇒ 什么都不做 ──
    ['没到交接线 ⇒ none（压缩照 B③ 走，不在这里管）',
      handoverOrCompress({ cost: 240000, win: W, gateRatio: G, compactAt: 1, compactIneffective: true }).action, 'none'],
    // ── 边界：刚好等于交接线也算到线 ──
    ['成本**恰好等于**交接线 ⇒ 算到线（不许因为浮点/取整放过）',
      handoverOrCompress({ cost: 300000, win: W, gateRatio: G, compactAt: 1, compactIneffective: true }).action, 'handover'],
    // ── 脏数据 ⇒ 绝不贸然交接（安全方向）──
    ['⛔ win=0 ⇒ none（没有窗口就没法判，不许瞎交接）',
      handoverOrCompress({ cost: 300000, win: 0, gateRatio: G, compactAt: 1, compactIneffective: true }).action, 'none'],
    ['⛔ cost=NaN ⇒ none（NaN 比较恒 false，显式拦）',
      handoverOrCompress({ cost: NaN, win: W, gateRatio: G, compactAt: 1, compactIneffective: true }).action, 'none'],
    ['传 null ⇒ none、不抛',
      handoverOrCompress(null).action, 'none'],
    // ── 这条最贵：**"曾经压过"不能当"压不动"** ──
    ['★★ 昨天压过一次（有效）今天涨到 413k ⇒ 仍然先压，⛔ 不许拿"压过"交接',
      handoverOrCompress({ cost: 413000, win: W, gateRatio: G, compactAt: 1, compactIneffective: false }).action, 'compress-first'],
  ];
  for (const c of handCases) cases.push(c);

  // ══════════════════════════════════════════════════════════════════════
  // ★★ 2026-11-03 13:25 删掉 `shouldReconsiderCompact`（连同它那 6 条自测）
  //
  //   它是什么：2026-11-03 11:45 为了绕开 6h 冷却而加的**特例**——
  //   "到交接线时压缩冷却作废"。它的全部 6 条自测都在验这个特例函数本身。
  //
  //   为什么现在必须删：13:10 宿主把冷却**整体删掉**了
  //   （「不用加 cd 什么 6 小时 12 小时，空闲十分钟如果超了就压缩」），
  //   B③ 入口不再看 `compactAt`，也不再需要"到线就无视冷却"这个特例。
  //
  //   ⚠ 为什么这是**必须修的假绿**，不是清理洁癖：
  //     留着 `shouldReconsiderCompact` + 6 条全绿的自测，等于**在验一个生产里没人调用的函数**。
  //     下一次有人看自测会以为"到交接线会被重新评估"仍受保护，而实际上那条路径已经不存在。
  //     这就是 06 文档说的"假绿比没有更糟"。
  //
  //   ⇒ 换成**验真路径**的断言：交接线以上的会话，只要空闲够，compressDue 仍然判 'compact'
  //     （证明"越危险越先压"这个意图仍然成立，而且是在真正被调用的函数上成立）。
  // ══════════════════════════════════════════════════════════════════════
  const coolCases = [
    ['★ 到交接线（117% 窗口）+ 空闲够 ⇒ 仍然先压（越危险越先压，意图还在）',
      compressDue({ cost: 351000, idleForMs: 30 * 60e3, compactLine: COST_COMPACT, now: 1e12 }).action, 'compact'],
    ['★ 到交接线 + 空闲不够 ⇒ 只等（交接线不是跳过空闲门槛的理由）',
      compressDue({ cost: 351000, idleForMs: 60e3, compactLine: COST_COMPACT, now: 1e12 }).action, 'wait-idle'],
    ['★ 到交接线 + 刚压过 1 分钟 + 空闲够 ⇒ **照样压**（⛔ 冷却已删，不许再拿它挡）',
      compressDue({ cost: 351000, idleForMs: 30 * 60e3, compactLine: COST_COMPACT, now: 1e12 }).action, 'compact'],
    ['⛔ 特例函数 shouldReconsiderCompact 必须已从源码消失（它只为绕 6h 冷却而生）',
      /function\s+shouldReconsiderCompact|const\s+shouldReconsiderCompact/.test(selfSrc), false],
    // ── 同样的"干跑不许写心跳"（本轮实测：干跑伪造心跳 ⇒ 守护拉双哨兵）──
    ['★★ 干跑不许写心跳（否则守护会以为哨兵死了 ⇒ 拉起第二个）',
      (() => {
        const i = selfSrc.indexOf('const beat = () => {');
        if (i < 0) return 'NOT_FOUND';
        const head = selfSrc.slice(i + 'const beat = () => {'.length, i + 420);
        return head.indexOf('if (DRYRUN) return;') >= 0 ? 'guarded' : 'NO_DRYRUN_GUARD';
      })(), 'guarded'],
  ];
  for (const c of coolCases) cases.push(c);

  // ══════════════════════════════════════════════════════════════════════
  // ★ 2026-11-03 10:55 加：**压缩只许有一条路**（干跑实测抓到的真 bug）
  //   干跑原文（修复前）：
  //     📝 落盘询问(第 1 次) → 工作台改造  153k
  //     📝 落盘询问(第 2 次·抢救段) → 工作台改造  153k
  //   10:01:11 / 10:01:38 同样两压（compactionId 99a3a44e… / 258ac7b2…），白烧两次摘要调用。
  //   根因：D「抢救式压缩」遍历的也是 `idle`，跟 B③ **完全同一集合** ⇒ 纯重复；
  //        而它声称要治的"永远 running 压不到"根本不在这个集合里 ⇒ 从来治不了那个病。
  //   ⇒ 现在 D 段整段删除，压缩执行点必须恒等于 1。下面这条断言守着它。
  // ══════════════════════════════════════════════════════════════════════
  const callSites = countCompactCallSites(selfSrc);
  // ★ 2026-11-03 11:20：干跑不许 spawn 真守护（本轮实测：干跑把第二个守护 34024 拉起来了）
  const guardSpawn = (() => {
    // ⚠⛔ 这里不能用字面量 `'function watchGuardian()'` 去 indexOf ——
    //   断言代码**自己就含有这个字符串**，indexOf 会命中断言本身，于是永远返回 'guarded'。
    //   第一版正是这样假绿的，被反例抓出来（变异体去掉守卫，自测照样 135/135）。
    //   正解：用能匹配函数**定义**的正则（行首 + function + 名字 + 参数表 + 换行 + 缩进 + 左花括号），
    //   这样断言里的字符串（单引号包着）不会命中。
    const m = selfSrc.match(/^function\s+watchGuardian\s*\(\s*\)\s*\{/m);
    if (!m) return 'NOT_FOUND';
    const start = m.index + m[0].length;              // 左花括号之后
    const body = selfSrc.slice(start, start + 1200);
    const head = body.slice(0, 400);                  // 只看函数体最前面
    const spAny = body.indexOf('spawn(' + 'process.execPath');
    if (spAny < 0) return 'NO_SPAWN';
    return head.indexOf('if (DRYRUN) return;') >= 0 ? 'guarded' : 'NO_DRYRUN_GUARD_AT_HEAD';
  })();
  const CM = 'commands' + '/execute';       // ⚠ 拼出来的：⛔ 不写字面量，否则下面这些样例会被自己数进去
  const pureCases = [
    ['★ 压缩执行点必须恰好 1 个（本轮实测到过 2 个并行通道，白烧两次模型）', callSites, 1],
    ['★★ 干跑不许 spawn 真守护（本轮实测：干跑拉起了第二个守护 PID 34024）', guardSpawn, 'guarded'],
    // ── ★★ 2026-11-03 11:30：ROOT 不许落到副本根 D:\Lintax数据 ──
    //   事故：spawnSync 用 `D:/Lintax数据/工具/派单.mjs` 绝对路径调用时，
    //   老的 `path.resolve(here,'..')` 把 ROOT 算成 **D:\Lintax数据**（工具\ 是 junction 指向那边），
    //   那里有 外壳\scenarios / 工具 / 引擎\.dsh，但**没有 外壳\main.js、也没有真的 server.log**
    //   ⇒ 拿不到 cookie ⇒ 派单静默退出 code=1，人还以为"通道坏了"。
    //   判据：真根必须**同时**有 外壳\main.js + 外壳\scenarios + 引擎\.dsh + 工具。
    ['★★ ROOT 判据：真工作台根（有 外壳\\main.js）⇒ 认',
      (() => {
        try {
          return fs.existsSync(path.join(ROOT, '外壳', 'main.js'))
            && fs.existsSync(path.join(ROOT, '外壳', 'scenarios'))
            && fs.existsSync(path.join(ROOT, '引擎', '.dsh'));
        } catch { return false; }
      })(), true],
    ['⛔ ROOT 判据：副本根 D:\\Lintax数据 必须**不认**（它没有 外壳\\main.js）',
      (() => {
        try {
          if (!fs.existsSync(path.join('D:', 'Lintax数据'))) return false;   // 没这个目录就无从谈起
          return fs.existsSync(path.join('D:', 'Lintax数据', '外壳', 'main.js'));
        } catch { return false; }
      })(), false],
    ['★ ROOT 必须落在真工作台（⛔ 不是脚本上级、更不是 D:\\Lintax数据）',
      /Lintax工作台/.test(String(ROOT)) && !/^D:[\\/]Lintax数据$/.test(String(ROOT).replace(/[\\/]+$/, '')), true],
    ['⛔ 注释里提到的 `/compact` 不算执行点（否则断言会被注释误导）',
      countCompactCallSites("// line: '/compact'\n/* line: '/compact' */\n * " + CM + " line: '/compact'\n"),
      0],
    ['⛔ 只是拼字符串、没有真正调用点的行也不算（自测自己就撞过这个假红）',
      countCompactCallSites('const s = "line: \'/compact\'";\n'), 0],
    ['真代码行才算（并且能数到 2，证明这条断言不是永真）',
      countCompactCallSites("a({ line: '/compact', m: '" + CM + "' });\nb({ m: '" + CM + "', line: '/compact' });\n"), 2],
    ['源码读不到时不许假绿（空串 ⇒ 0 ⇒ 和期望 1 不符）',
      countCompactCallSites(''), 0],

    // ══════════════════════════════════════════════════════════════════════
    // ★★ 2026-11-03 12:35：**真实成本取值必须和引擎 UI 逐字一致**
    //   引擎 `contextOccupancy` 是 `projectedTokens ?? pressureTokens`（`??`，0 是合法读数）。
    //   分叉只在 projectedTokens **恰好为 0** 时出现；实测活会话 0 个分叉、归档有 3 个
    //   ⇒ 这是**消除潜在分歧**，不是"已经在害人"的 bug。诚实标注，别夸大。
    // ══════════════════════════════════════════════════════════════════════
    ['★ projectedTokens=433（压缩刚结束的典型值）⇒ 取 433，不许回退读冻住的 256946',
      pickCost({ projectedTokens: 433, pressureTokens: 256946 }), 433],
    ['★ projectedTokens 就是 0 ⇒ 取 0（引擎用 ??，0 是合法读数，不是"没有"）',
      pickCost({ projectedTokens: 0, pressureTokens: 256946 }), 0],
    ['★ projectedTokens 比 pressureTokens 小很多（正常压缩后）⇒ 取小的那个（以 projected 为准）',
      pickCost({ projectedTokens: 51234, pressureTokens: 256946 }), 51234],
    ['★ projectedTokens 缺失 ⇒ 才允许兜底 pressureTokens',
      pickCost({ pressureTokens: 123456 }), 123456],
    ['⛔ 两个都没有 ⇒ 0（安全方向：不会被误判成超线去压别人）',
      pickCost({}), 0],
    ['⛔ undefined 整个不传 ⇒ 0（不许抛异常把整轮 tick 打死）',
      pickCost(undefined), 0],
    ['⛔ NaN 当缺失处理 ⇒ 兜底 pressureTokens（脏数据不许污染判据）',
      pickCost({ projectedTokens: NaN, pressureTokens: 77777 }), 77777],
    ['★ 正例对照：两者相近时取 projected（证明上面不是"恒等于 pressure"的假绿）',
      pickCost({ projectedTokens: 232865, pressureTokens: 232629 }), 232865],
    ['⛔ 源码里不许再出现 `|| Number(cp.pressureTokens)` 这种把 0 当空值的写法（静态断言，防回潮）',
      // ⚠ 必须先剔掉注释行再测：pickCost 的说明注释里**原样引用了老写法**当反例，
      //    直接扫全文会把那段引用判成"代码里还有" ⇒ 假红（和 countCompactCallSites 踩的是同一个坑）。
      (() => {
        const code = String(selfSrc || '').split(/\r?\n/)
          .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
          .join('\n');
        return new RegExp('projectedTokens\\)' + '\\s*\\|\\|').test(code);
      })(), false],
    ['★ 源码里必须真的调用 pickCost（否则断言全在验一个没人用的函数）',
      (selfSrc.match(/pickCost\(cp\)/g) || []).length >= 1, true],

    // ══════════════════════════════════════════════════════════════════════
    // ★★ 2026-11-03 12:41：**三档水位必须互斥且从高到低**
    //   事故：显示层把 收尾线(200k) 判在 压缩线(240k) 前面 ⇒ `⤵该压缩` 永远显示不出来；
    //        结论区两个 filter 上下界互相打架 ⇒ `⤵ 该压缩的` 一节恒为空。
    //   两条都**只错在显示**，所以哨兵照常干活、自测全绿，而人看到的结论是反的。
    //   判据要**关系**：档位必须是"互斥 + 单调"，所以下面正反、边界、乱序都打。
    // ══════════════════════════════════════════════════════════════════════
    ['★ 256k/300k 必须判「该压缩」（⛔ 不许被 200k 收尾档抢先 —— 这正是宿主看到的错）',
      waterLine(256946, 300000), 'compact'],
    ['★ 233k/300k ⇒ 收尾档（未到 240k 压缩线）', waterLine(232865, 300000), 'warn'],
    ['★ 恰好 240k ⇒ 压缩档（边界含等号）', waterLine(240000, 300000), 'compact'],
    ['★ 恰好 200k ⇒ 收尾档（边界含等号）', waterLine(200000, 300000), 'warn'],
    ['★ 199999 ⇒ 不提醒（差 1 tok 就不该催）', waterLine(199999, 300000), 'none'],
    ['★ 窗口 100% 优先判交接（哪怕同时 ≥240k）', waterLine(300000, 300000), 'handover'],
    ['★ 压缩后 433 tok ⇒ 哪一档都不是（⛔ 不许因为它 ≥200k 之外的理由被催）', waterLine(433, 300000), 'none'],
    ['⛔ 窗口缺失（0）⇒ 不判交接档，但仍按绝对值判压缩（不许因缺窗口就静默）',
      waterLine(250000, 0), 'compact'],
    ['⛔ 成本 NaN ⇒ none（脏数据不许触发任何动作）', waterLine(NaN, 300000), 'none'],
    ['★ 单调性：成本越大档位越靠前，⛔ 不许出现"涨了反而降档"',
      [150000, 210000, 250000, 320000].map((c) => waterLine(c, 300000)).join(','), 'none,warn,compact,handover'],
    ['★ render 与结论区必须**都**走 waterLine（静态断言，防有人再抄一份 if 链写反）',
      (selfSrc.match(/waterLine\(r\.proj, r\.win\)/g) || []).length >= 2, true],

    // ══════════════════════════════════════════════════════════════════════
    // ★★ 2026-11-03 13:10 宿主定稿：**不用 6h/12h 冷却，空闲 10 分钟过线就压**
    //   判据全部收进 compressDue（纯函数）。这里正反两边都打：
    //   ① 该压的必须压（空闲够 + 过线）
    //   ② 不该压的必须忍住（空闲不够 / 没过线 / 刚失败在退避 / 脏数据）
    //   ③ 边界和单调性（9:59 等 / 10:00 压；249999 不压 / 240000 压）
    //   ⛔ 特别加一条"昨天的压缩不算今天的禁令"：compactAt 再近也不许拦住它。
    // ══════════════════════════════════════════════════════════════════════
    ['★★ 空闲 10 分钟 + 过压缩线 ⇒ 立刻压（宿主定的唯一判据）',
      compressDue({ cost: 260000, idleForMs: 10 * 60e3, compactLine: COST_COMPACT, now: 1e12 }).action, 'compact'],
    ['★ 空闲 9 分 59 秒 ⇒ 再等（差 1 秒也不压，等人家思考完）',
      compressDue({ cost: 260000, idleForMs: 10 * 60e3 - 1000, compactLine: COST_COMPACT, now: 1e12 }).action, 'wait-idle'],
    ['★ 空闲 3 小时 ⇒ 照样压（⛔ 长时间空闲不是"免压"理由）',
      compressDue({ cost: 260000, idleForMs: 3 * 3600e3, compactLine: COST_COMPACT, now: 1e12 }).action, 'compact'],
    ['★ 空闲够但没过压缩线 ⇒ 不压',
      compressDue({ cost: 239999, idleForMs: 60 * 60e3, compactLine: COST_COMPACT, now: 1e12 }).action, 'none'],
    ['★ 恰好 240k + 空闲 10 分钟 ⇒ 压（边界含等号）',
      compressDue({ cost: 240000, idleForMs: 10 * 60e3, compactLine: COST_COMPACT, now: 1e12 }).action, 'compact'],
    ['★★ **刚压过 1 分钟**，但空闲够且又过线 ⇒ 仍然要压（⛔ 不许用"上次压过多久"当禁令）',
      compressDue({ cost: 260000, idleForMs: 20 * 60e3, compactLine: COST_COMPACT, now: 1e12 }).action, 'compact'],
    ['★ 压失败 3 分钟前 ⇒ 退避（10 分钟后重试）',
      compressDue({ cost: 260000, idleForMs: 20 * 60e3, compactLine: COST_COMPACT, failAt: 1e12 - 3 * 60e3, now: 1e12 }).action, 'retry-later'],
    ['★ 压失败已过 11 分钟 ⇒ 立刻重试（退避不是冷却）',
      compressDue({ cost: 260000, idleForMs: 20 * 60e3, compactLine: COST_COMPACT, failAt: 1e12 - 11 * 60e3, now: 1e12 }).action, 'compact'],
    ['⛔ 成本 NaN ⇒ 不动（脏数据不许压别人）',
      compressDue({ cost: NaN, idleForMs: 20 * 60e3, compactLine: COST_COMPACT, now: 1e12 }).action, 'none'],
    ['⛔ 空闲时长 NaN ⇒ 不动', compressDue({ cost: 260000, idleForMs: NaN, compactLine: COST_COMPACT, now: 1e12 }).action, 'none'],
    ['⛔ 从未空闲（idleForMs=0）但已过线 ⇒ 只等，不压',
      compressDue({ cost: 400000, idleForMs: 0, compactLine: COST_COMPACT, now: 1e12 }).action, 'wait-idle'],
    ['★ 单调性：空闲时长越长，动作只能"更靠前"（等→压），⛔ 不许反悔',
      [0, 5 * 60e3, 10 * 60e3, 60 * 60e3].map((i) => compressDue({ cost: 260000, idleForMs: i, compactLine: COST_COMPACT, now: 1e12 }).action).join(','),
      'wait-idle,wait-idle,compact,compact'],
    ['★★ 源码里不许再出现 6h/12h 的压缩冷却参与 B③ 入口（静态断言，防回潮）',
      /!st\.compactAt\s*\|\|\s*\(now - st\.compactAt\)/.test(selfSrc), false],
    ['★ B③ 入口必须真的调用 compressDue（⛔ 不许流程里再自己写阈值比较）',
      (selfSrc.match(/compressDue\(\{/g) || []).length >= 1, true],

    // ── ★★ 2026-11-03 13:2x 宿主：「超了就询问，然后**等回复后压缩**」──
    //   它回完话就已经停手了 ⇒ ⛔ 不许再拿"空闲 10 分钟"卡它（否则每次压缩白等一轮）。
    //   10 分钟门槛只对**开口问**那一步成立。
    ['★★ 已回话（answered）+ 刚空闲 0 分钟 + 过线 ⇒ **立刻压**（⛔ 不许再等 10 分钟）',
      compressDue({ cost: 260000, idleForMs: 0, compactLine: COST_COMPACT, now: 1e12, answered: true }).action, 'compact'],
    ['★ 没回话 + 刚空闲 0 分钟 ⇒ 只等（先别打扰正在收尾的人）',
      compressDue({ cost: 260000, idleForMs: 0, compactLine: COST_COMPACT, now: 1e12, answered: false }).action, 'wait-idle'],
    ['⛔ 就算已回话，**没过压缩线**也不许压（回话不是越过阈值通行证）',
      compressDue({ cost: 239999, idleForMs: 0, compactLine: COST_COMPACT, now: 1e12, answered: true }).action, 'none'],
    ['⛔ 已回话但刚压失败 ⇒ 仍然退避（回话不免失败退避）',
      compressDue({ cost: 260000, idleForMs: 0, compactLine: COST_COMPACT, now: 1e12, answered: true, failAt: 1e12 - 60e3 }).action, 'retry-later'],
    ['★ 源码里 compressDue 调用处必须真的传 answered（否则"等回复后压缩"永远走不到）',
      /compressDue\(\{[\s\S]{0,240}answered:\s*preAnswered/.test(selfSrc), true],
  ];

  // ── ★★ 2026-11-03 18:20 新增·**步数闸 / 输出量闸**（runaway 报警）──
  //   判据必须是**关系**（"这一轮多了几步"），⛔ 不是"最近 N 步"这种按条数截断的快照
  //   （这是哨兵自己栽过的第 3 次：answeredThisAsk 的 .slice(-8)）。
  //   每条用例只依赖**一个**判据 ⇒ 变异测试能逐条打红。
  // ── 样本构造：prev 是上一 tick 的快照，cur 是本次采样（累计值）──
  //   一次跑飞 = 1 轮里跑了 30 步、输出 30000 token ⇒ 远超 8 步/轮 与 8000 token/轮
  //   一次正常 = 1 轮里跑了 4 步、输出 1200 token ⇒ 两个闸都不该响
  const gateRunaway = stepGateVerdict({
    turns: 31, steps: 930, decodeTokens: 900000,
    prev: { turns: 30, steps: 900, decodeTokens: 870000, hist: [] },
  });
  const gateNormal = stepGateVerdict({
    turns: 31, steps: 904, decodeTokens: 871200,
    prev: { turns: 30, steps: 900, decodeTokens: 870000, hist: [] },
  });
  // 阈值可覆盖：--步数上限 3 时，5 步/轮也要报警
  const gateLowLimit = stepGateVerdict({
    turns: 31, steps: 905, decodeTokens: 870100,
    prev: { turns: 30, steps: 900, decodeTokens: 870000, hist: [] },
    stepLimit: 3,
  });
  // 只超步数：输出不超 ⇒ 只报「步数超标」一条
  const gateStepsOnly = stepGateVerdict({
    turns: 31, steps: 930, decodeTokens: 871000,
    prev: { turns: 30, steps: 900, decodeTokens: 870000, hist: [] },
  });
  // 只超输出：步数不超 ⇒ 只报「输出过长」一条
  const gateOutputOnly = stepGateVerdict({
    turns: 31, steps: 901, decodeTokens: 900000,
    prev: { turns: 30, steps: 900, decodeTokens: 870000, hist: [] },
  });

  const stepGateCases = [
    ['★★ 步数闸：30 步/轮 ⇒ 判「跑太多趟」（步/轮 > 8）',
      gateRunaway.overSteps, true],
    ['★★ 步数闸：4 步/轮 ⇒ **不报**（反侧：正常会话不许被噪音误伤）',
      gateNormal.overSteps, false],
    ['★★ 输出量闸：30000 token/轮 ⇒ 判「输出过长」（> 8000）',
      gateRunaway.overOutput, true],
    ['★★ 输出量闸：1200 token/轮 ⇒ **不报**（反侧）',
      gateNormal.overOutput, false],
    ['★ 两条闸合并成一次命中（两个都超 ⇒ hit 只有一次推送）',
      gateRunaway.hit && gateRunaway.reasons.length === 2, true],
    ['★ 只超步数 ⇒ reasons 只含「步数超标」（不推两条骚扰宿主）',
      gateStepsOnly.reasons.join(','), '步数超标'],
    ['★ 只超输出 ⇒ reasons 只含「输出过长」',
      gateOutputOnly.reasons.join(','), '输出过长'],
    ['★★ --步数上限 3 ⇒ 5 步/轮也报警（参数真能被覆盖，不是写死的 8）',
      gateLowLimit.overSteps, true],
    ['★★ 判据是关系不是快照：同一段跑飞，**再多跑 50 轮仍然判超**（⛔ 不许按条数截断）',
      stepGateVerdict({ turns: 81, steps: 2400, decodeTokens: 2400000,
        prev: { turns: 80, steps: 2370, decodeTokens: 2370000, hist: [{ turns: 1, steps: 30, decode: 30000 }] } }).overSteps, true],
    ['★★ 短会话噪声防护：只跑 1 轮就跑飞也报警（窗口不满 3 轮时用现有的那几轮）',
      stepGateVerdict({ turns: 2, steps: 30, decodeTokens: 30000,
        prev: { turns: 1, steps: 0, decodeTokens: 0, hist: [] } }).overSteps, true],
    ['⛔ 没新轮次（dTurns<=0）⇒ 不出样本 ⇒ **不报**（停着不动不算跑飞）',
      stepGateVerdict({ turns: 30, steps: 930, decodeTokens: 900000,
        prev: { turns: 30, steps: 900, decodeTokens: 870000, hist: [] } }).overSteps, false],
    ['⛔ 计数器倒退（换会话/重启）⇒ 不出样本 ⇒ 不报（不拿脏数据误判）',
      stepGateVerdict({ turns: 1, steps: 3, decodeTokens: 100,
        prev: { turns: 30, steps: 900, decodeTokens: 870000, hist: [] } }).overSteps, false],
    ['★ 快照必须每轮都更新（否则下一次算不出差分 ⇒ 永远只有 1 个样本）',
      gateRunaway.next.turns === 31 && gateRunaway.next.steps === 930, true],
    ['★ 滚动窗口最多 3 个样本（⛔ 不是无限增长）',
      (() => {
        let prev = { turns: 0, steps: 0, decodeTokens: 0, hist: [] };
        for (let i = 1; i <= 10; i++) {
          const v = stepGateVerdict({ turns: i, steps: i * 30, decodeTokens: i * 30000, prev });
          prev = v.next;
        }
        return prev.hist.length;
      })(), 3],
    ['★ 源码里必须真的接了 STEP_LIMIT（⛔ 不许把 8 写死在流程里）',
      /stepLimit:\s*STEP_LIMIT/.test(selfSrc), true],
    ['★★ 输出量闸必须读**真实存在**的字段（⛔ 不许引用顶层不存在的 r.decodeTokens）',
      (() => {
        // 锚点用**真实传参行**：自测文本里没有 `decodeTokens: r.` 这个形状 ⇒ 不会被自己抢先命中
        const m = selfSrc.match(/decodeTokens: r\.[A-Za-z.]+/);
        const got = m ? m[0] : '';
        return got === 'decodeTokens: r.progress.decodeTokens';
      })(), true],
    ['★★ snapshot 必须真的产出 progress.decodeTokens（输出量闸的数据源）',
      /decodeTokens: Number\(v\.sessionStats && v\.sessionStats\.decodeTokens\) \|\| 0,/.test(selfSrc), true],
    ['★★ A③ 段必须把 progress.decodeTokens 传进闸（⛔ 顶层没有这个字段）',
      /decodeTokens: r\.progress\.decodeTokens,/.test(selfSrc), true],
    ['★ 源码里必须真的接了 OUTPUT_LIMIT',
      /outputLimit:\s*OUTPUT_LIMIT/.test(selfSrc), true],
    ['★★ 步数闸必须是**纯函数** stepGateVerdict（⛔ 不许把判据写死在流程里）',
      /^function stepGateVerdict\(/m.test(selfSrc), true],
    ['★★ 两条闸合并成**一条**提醒（行为断言：⛔ 不许出两个独立命中标志）',
      (() => {
        const keys = Object.keys(gateRunaway).sort().join(',');
        return !/hitSteps|hitOutput|hit2|alert2/.test(keys) && gateRunaway.hit === true;
      })(), true],
    ['★★ 两条闸合并成**一条**提醒（行为断言：两个都超时 reasons 仍有 2 条 ⇒ 一条文案里列两项）',
      gateRunaway.hit === true && gateRunaway.reasons.length === 2 && gateRunaway.reasons.indexOf('步数超标') >= 0 && gateRunaway.reasons.indexOf('输出过长') >= 0, true],
    ['★★ 步数闸**不产出任何动作**（⛔ 只报警：不许返回压缩/派单动作）',
      (() => {
        const keys = Object.keys(gateRunaway).sort().join(',');
        return !/action|compact|dispatch|ticket|handover/i.test(keys);
      })(), true],
    ['★★ 步数闸的判定结果里不许出现「压缩/派单」语义（⛔ 纯报警）',
      (() => {
        const body = (selfSrc.match(/function stepGateVerdict[\s\S]*?\n}/) || [''])[0];
        return !/compressDue|派单\.mjs|dispatchTicket/.test(body);
      })(), true],
    ['★★ 流程里调用步数闸时**必须**把两条闸合在一个 push 里（⛔ 不许推两条）',
      (() => {
        // 只看**流程里那一行调用**：形如 stepGateVerdict({ ... }) 之后紧跟一个 parts.push
        const m = selfSrc.match(/const gv = stepGateVerdict\(\{[\s\S]{0,400}?\}\);[\s\S]{0,2200}?const ok = await push\(/);
        if (!m) return false;
        const seg = m[0];
        return (seg.match(/await push\(/g) || []).length === 1 && seg.indexOf('parts.push') >= 0;
      })(), true],
    ['★ 收尾线默认 200000 且压缩线 240000（启动改由 vbs+守护，不再读 启动哨兵.cmd）',
      (() => {
        // 2026-11-07：五个文件里没有 启动哨兵.cmd；判据直接认本文件默认值，
        // ⛔ 不再读不存在的 .cmd（否则自测恒红）。下一条断言仍独立验 COST_WARN < COST_COMPACT。
        return COST_WARN === 200000 && COST_COMPACT === 240000 ? 200000 : -1;
      })(), 200000],
    ['★ COST_WARN 必须严格小于 COST_COMPACT（收尾线==压缩线 ⇒ 压缩永远轮不到）',
      COST_WARN < COST_COMPACT, true],
    ['★ STEP_LIMIT 默认 8、OUTPUT_LIMIT 默认 8000',
      STEP_LIMIT === 8 && OUTPUT_LIMIT === 8000, true],
    // ════════════════════════════════════════════════════════════════
    // ★ 派单原文《哨兵加「步数闸」》自测要求 1~8 —— **逐条照抄派单给的数值**
    //   （prev 用全 0 ⇒ 差分 = 累计值 ⇒ 与派单的「turns:10, steps:100」同义）
    //   ⚠ 派单第 8 条要求「`>` 改成 `>=` 自测必须变红」⇒ 必须有**恰好等于阈值**的用例：
    //     8 步/轮（=8）改 `>=` 后会误报 ⇒ 用例要能杀掉它；同理 8000 token/轮（=8000）。
    // ════════════════════════════════════════════════════════════════
    ['【派单①】turns:10, steps:100 ⇒ 10 步/轮 > 8 ⇒ 步数闸**必须触发**',
      stepGateVerdict({ turns: 10, steps: 100, decodeTokens: 200000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overSteps, true],
    ['【派单②】同上但 steps:40 ⇒ 4 步/轮 ⇒ 步数闸**必须不触发**（反侧）',
      stepGateVerdict({ turns: 10, steps: 40, decodeTokens: 200000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overSteps, false],
    ['【派单③】turns:10, steps:10, decodeTokens:200000 ⇒ 20000 token/轮 > 8000 ⇒ 输出闸**必须触发**',
      stepGateVerdict({ turns: 10, steps: 10, decodeTokens: 200000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overOutput, true],
    ['【派单④】turns:10, steps:10, decodeTokens:20000 ⇒ 2000 token/轮 ⇒ 输出闸**必须不触发**（反侧）',
      stepGateVerdict({ turns: 10, steps: 10, decodeTokens: 20000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overOutput, false],
    ['【派单⑤】两个都超 ⇒ **两条都报**（reasons 同时含两项），不是只报一条',
      (() => {
        const g = stepGateVerdict({ turns: 10, steps: 100, decodeTokens: 200000,
          prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } });
        return g.overSteps === true && g.overOutput === true && g.reasons.length === 2
          && g.reasons.indexOf('步数超标') >= 0 && g.reasons.indexOf('输出过长') >= 0;
      })(), true],
    ['【派单⑥】turns:0（刚开新会话）⇒ **不报、不崩**（除零防护：既不步数超标也不输出过长）',
      (() => {
        const g = stepGateVerdict({ turns: 0, steps: 0, decodeTokens: 0,
          prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } });
        return g.overSteps === false && g.overOutput === false && g.hit === false;
      })(), true],
    ['【派单⑥-b】turns:0 但 steps 很大 ⇒ 仍然不报（除零 ⇒ 步/轮无意义，不能当成跑飞）',
      stepGateVerdict({ turns: 0, steps: 500, decodeTokens: 900000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).hit, false],
    ['【派单⑦】阈值参数 --步数上限 3 ⇒ 3 步/轮就报（证明参数真生效，不是写死的 8）',
      stepGateVerdict({ turns: 10, steps: 30, decodeTokens: 20000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] },
        stepLimit: 3 }).overSteps, true],
    ['【派单⑦-b】同一份数据在阈值 8 下**不报**（3 步/轮 ≤ 8）⇒ 同一个纯函数按参数走，不是两个判据',
      stepGateVerdict({ turns: 10, steps: 30, decodeTokens: 20000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] },
        stepLimit: 8 }).overSteps, false],
    ['【派单⑧-边界】恰好 8 步/轮（= 上限）⇒ **报**（阈值语义：踩到上限即提醒）',
      stepGateVerdict({ turns: 10, steps: 80, decodeTokens: 20000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overSteps, true],
    ['【派单⑧-边界】恰好 8000 token/轮（= 上限）⇒ **报**（阈值语义：踩到上限即提醒）',
      stepGateVerdict({ turns: 10, steps: 10, decodeTokens: 80000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overOutput, true],
    ['【派单⑧-边界】8.1 步/轮（刚过上限）⇒ **报**（正侧：证明不是漏报）',
      stepGateVerdict({ turns: 10, steps: 81, decodeTokens: 20000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overSteps, true],
    ['【派单⑧-边界】8001 token/轮（刚过上限）⇒ **报**（正侧）',
      stepGateVerdict({ turns: 10, steps: 10, decodeTokens: 80010,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overOutput, true],
    ['【派单⑧-边界】7.9 步/轮（上限下方）⇒ **不报**（下界钉死：不是无脑全报）',
      stepGateVerdict({ turns: 10, steps: 79, decodeTokens: 20000,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overSteps, false],
    ['【派单⑧-边界】7999 token/轮（上限下方）⇒ **不报**（下界钉死）',
      stepGateVerdict({ turns: 10, steps: 10, decodeTokens: 79990,
        prev: { turns: 0, steps: 0, decodeTokens: 0, hist: [] } }).overOutput, false],
  ];
  for (const c of stepGateCases) cases.push(c);

  // ★★★ 真并发抢锁用例（2026-11-03 20:40）
  //
  //   为什么必须真并发（纯函数自测根本测不出来）：
  //     旧 takeLock 是 **TOCTOU**（先读后写）⇒ 只有**真的一起冲**才会撞上窗口。
  //     我第一版自测用「依次 spawnSync」⇒ 第一个早写完了 ⇒ 测**永远绿**（假绿）。
  //     ⇒ 必须用「起跑门」：所有子进程先报到，再一起放闸。
  //   这两条用例就是本轮的防回归闸：
  //     A：同时冲 ⇒ 恰好 1 个拿到（把 wx 改回普通写 ⇒ 立刻红）
  //     B：锁文件已建、内容未写完 ⇒ 后来者必须让出（删掉年龄保护 ⇒ 立刻红）
  //
  //   ⚠ 子进程是**独立进程** ⇒ takeLock/parseLock/lockState/pidAlive 都不在它作用域里
  //     ⇒ 必须把**这几个函数的源码**注入进去（否则子进程 ReferenceError，
  //     父进程只会看到"子进程异常退出" —— 判据假绿）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const { spawn } = await import('node:child_process');
    const os2 = await import('node:os');
    const SB = fs.mkdtempSync(path.join(os2.tmpdir(), 'sentinel-locktest-'));
    // 子进程脚本：报到 ⇒ 等门 ⇒ 抢锁
    const grabFn = (name) => {
      const a = selfSrc.split(/\r?\n/);
      const s = a.findIndex((l) => l.startsWith('function ' + name + '('));
      if (s < 0) return '';
      let e = s;
      while (e < a.length && a[e] !== '}') e++;
      return a.slice(s, e + 1).join('\n');
    };
    // ⚠ 2026-11-08：`pidAlive` 已搬进 `_进程存活.mjs` ⇒ 从本文件抓不到它了。
    //   子进程必须跑**同一份实现** ⇒ 把模块源码（去 shebang / 去 export 前缀）整段注入。
    //   ⛔ 不许在自测里另写一份判活 —— 那正是本单要治的病（三份各写一遍）。
    const pidModSrc = (() => {
      try {
        return fs.readFileSync(new URL('./_进程存活.mjs', import.meta.url), 'utf8')
          .replace(/^#![^\r\n]*\r?\n/, '')
          .replace(/^export\s+/gm, '');
      } catch { return ''; }
    })();
    const fnSrc = ['parseLock', 'lockState', 'takeLock'].map(grabFn).join('\n\n');
    const kid = path.join(SB, 'kid.mjs');
    fs.writeFileSync(kid, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      pidModSrc,
      fnSrc,
      "const READY = process.argv[2], GO = process.argv[3], LOCK = process.argv[4];",
      "fs.writeFileSync(path.join(READY, 'r' + process.pid), '1');",
      "const t0 = Date.now();",
      "while (!fs.existsSync(GO)) {",
      "  if (Date.now() - t0 > 20000) { console.log(JSON.stringify({ok:null,pid:process.pid,why:'等门超时'})); process.exit(9); }",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);",
      "}",
      "const r = takeLock(LOCK);",
      "console.log(JSON.stringify({ ok: r.ok, pid: process.pid, why: r.why }));",
      "if (r.ok) setInterval(() => {}, 1000);",
    ].join('\n'), 'utf8');

    const raceOnce = async (lockFile, n, tag) => {
      const goFile = path.join(SB, 'go-' + tag);
      const readyDir = path.join(SB, 'r-' + tag);
      fs.mkdirSync(readyDir, { recursive: true });
      const ps = [];
      for (let k = 0; k < n; k++) {
        const c = spawn(process.execPath, [kid, readyDir, goFile, lockFile], { stdio: ['ignore', 'pipe', 'pipe'] });
        ps.push(new Promise((resolve) => {
          let out = '', done = false;
          c.stdout.on('data', (d) => {
            out += d;
            const nl = out.indexOf('\n');
            if (nl < 0 || done) return;
            let o = null;
            try { o = JSON.parse(out.slice(0, nl).trim()); } catch { return; }
            done = true;
            resolve({ c, ok: o.ok, pid: o.pid, why: o.why });
          });
          c.stderr.on('data', () => { });
          c.on('close', () => { if (!done) { done = true; resolve({ c, ok: null, pid: null, why: '子进程异常退出' }); } });
        }));
      }
      // 等所有子进程报到
      const t0 = Date.now();
      while (fs.readdirSync(readyDir).length < n && Date.now() - t0 < 15000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const readyN = fs.readdirSync(readyDir).length;
      fs.writeFileSync(goFile, 'GO');               // ★ 放闸：所有人同时冲
      const res = await Promise.all(ps);
      for (const r of res) { try { r.c.kill(); } catch { } }
      return { readyN, res, winners: res.filter((r) => r.ok === true), losers: res.filter((r) => r.ok === false) };
    };

    // ── 用例 A：同时冲 ⇒ 恰好 1 个拿到 ──
    const lockA = path.join(SB, 'a.lock');
    const A = await raceOnce(lockA, 6, 'A');
    let lockARaw = '';
    try { lockARaw = fs.readFileSync(lockA, 'utf8').trim(); } catch { }
    console.log('  · 真并发A：报到=' + A.readyN + '/6  拿到=' + A.winners.length + '  退出=' + A.losers.length + '  锁=' + lockARaw);
    cases.push(
      ['🔒 真并发：6 个进程同时抢锁 ⇒ **恰好 1 个**拿到（TOCTOU 旧版会 6 个全拿到）',
        A.winners.length, 1],
      ['🔒 真并发：其余 5 个都干净退出（不许半路崩）', A.losers.length, 5],
      ['🔒 真并发：锁文件里就是那个赢家的 pid', lockARaw.split('|')[0], String(A.winners[0] ? A.winners[0].pid : '')],
    );

    // ── 用例 B：锁文件已建、内容未写完 ⇒ 后来者必须让出 ──
    const lockB = path.join(SB, 'b.lock');
    fs.writeFileSync(lockB, '');                   // ★ 模拟赢家 open('wx') 建好但还没 write
    const B = await raceOnce(lockB, 1, 'B');
    const bStillThere = fs.existsSync(lockB);
    console.log('  · 真并发B：后来者 ok=' + (B.res[0] ? B.res[0].ok : '?') + '  理由=' + String(B.res[0] ? B.res[0].why : '').slice(0, 70));
    cases.push(
      ['🔒 竞态窗口：锁文件刚建、内容未写完 ⇒ 后来者必须让出（不许抢走别人的锁）',
        B.res[0] ? B.res[0].ok : null, false],
      ['🔒 竞态窗口：后来者不许把别人的锁文件删掉', bStillThere, true],
    );

    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* 删不掉不影响判据 */ }
  }

  for (const c of pureCases) cases.push(c);

  let bad = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    if (!ok) bad++;
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   得到=' + got + ' 期望=' + want));
  }
  console.log('\n自测：' + (cases.length - bad) + '/' + cases.length + (bad ? ' ✗ 有 ' + bad + ' 条不符' : ' ✓ 全过'));
  // ══════════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════

  process.exit(bad ? 1 : 0);
}

// ★ 2026-11-02 修：`--干跑` **绝不能写状态文件**。
//   踩过：干跑一次就把 `compactAt / gatedAt` 记成"刚提醒过"，
//   真哨兵启动后读到这份 state ⇒ 6 小时内不再提醒 ⇒ 干跑把真提醒吞了。
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(o) {
  if (DRYRUN) return;                    // 干跑只打印，不留痕
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(o, null, 1)); } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════════
// ★ 单实例锁（2026-11-03 16:45 · 派单第 ④ 条）
//
//   事故：15:28:30 起有**两个**哨兵进程（PID 34940 父=electron、39904 父=守护），
//   从此 `session-sentinel.log` **每一行都成对出现**（催促推两遍、16:28:31 与 16:29:01 各压一次，
//   第一条还报 `agent is not idle`）⇒ 宿主问「怎么发了两遍」。
//   根因：`哨兵守护.mjs` 拉起前**没有"已经有一个在跑"的检查**，哨兵自己也没有锁。
//
//   ✅ 判据是**关系**不是快照：锁文件里记 pid，"这个 pid 还活着吗" ⇒ 锁有效。
//      锁文件存在但 pid 已死（上次崩溃残留）⇒ 锁是**垃圾**，可以接管。
//      ⇒ 不按 mtime 判（快照），也不看"文件在不在"（垃圾锁会把哨兵锁死）。
// ══════════════════════════════════════════════════════════════════════════

/**
 * pid 是否真的活着 ⇒ **统一改用 `_进程存活.mjs` 的 `pidAlive`**（★ 2026-11-08）。
 *
 *   ⛔ 旧实现：`process.kill(pid,0)` 抛 EPERM 就直接算活着。
 *     事故（哨兵守护 16:22 连拒两轮）：本机对**已死 pid** 也抛 EPERM
 *     ⇒ 死 pid 被判"在岗" ⇒ 锁永远拿不走 / 守护永久拒绝重拉哨兵。
 *   ✅ 新实现：EPERM 必须用第二来源（tasklist）复核进程真在，复核不可用也不算活。
 *   ⛔ 判活实现只有一份；本文件、watchGuardian、哨兵守护共用，不许再就地重写。
 */

/**
 * 锁文件内容 → { pid, at }。脏数据返回 null（⛔ 不猜、不当活）。
 * @param {string} raw
 * @returns {{pid:number, at:number}|null}
 */
function parseLock(raw) {
  const m = String(raw || '').trim().match(/^(\d+)\|(\d+)$/);
  if (!m) return null;
  const pid = Number(m[1]), at = Number(m[2]);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(at) || at <= 0) return null;
  return { pid, at };
}

/**
 * 锁能不能拿？**纯函数，可单测**。
 *   · 没人持锁 ⇒ 能拿
 *   · 有人持锁且 pid 还活着 ⇒ **不能拿**（那就是"已经有哨兵在跑"）
 *   · 有人持锁但 pid 已死 ⇒ 锁是崩溃残留 ⇒ 能拿（接管）
 * @param {{raw:string, pidAliveFn?:Function}} p
 * @returns {{ok:boolean, why:string, holder?:number}}
 */
function lockState({ raw, pidAliveFn = pidAlive }) {
  const l = parseLock(raw);
  if (!l) return { ok: true, why: '没有锁（或锁是脏数据）⇒ 可以拿' };
  if (pidAliveFn(l.pid)) return { ok: false, why: '哨兵 pid ' + l.pid + ' 还活着 ⇒ 已有实例在跑', holder: l.pid };
  return { ok: true, why: '锁是残留的（pid ' + l.pid + ' 已死）⇒ 可以接管', holder: l.pid };
}

/**
 * 真的去拿锁：能拿就写自己的 pid，拿不到就返回 false。
 * @param {string} file
 * @param {Function} [pidAliveFn]
 * @returns {{ok:boolean, why:string, holder?:number}}
 */
function takeLock(file, pidAliveFn = pidAlive) {
  // ══════════════════════════════════════════════════════════════════════
  // ★★★ 2026-11-03 20:40：**原子**拿锁（修「同秒启动 ⇒ 两个哨兵都起来」）
  //
  //   事故：15:28:30 起跑着**两个**哨兵（PID 34940 父=electron / 39904 父=守护）
  //   ⇒ 日志每一行成对出现（催促推两遍、19:25 各压一次）。
  //   ⛔ 旧写法是 **TOCTOU**：先 readFileSync 读、再 writeFileSync 写 ——
  //     两个进程**同秒启动**时，两个都读到「没锁」⇒ 两个都写成功 ⇒ 两个都跑起来。
  //     单实例锁存在，但**锁不住同秒启动的那一对**。
  //
  //   正解：**独占创建**（O_CREAT|O_EXCL）—— 由操作系统保证原子性。
  //     · 拿到 ⇒ 文件是我建的 ⇒ 我是唯一实例
  //     · EEXIST ⇒ 别人已经建了 ⇒ 读它的 pid 判断：
  //         活着 ⇒ 真的有另一个实例在跑 ⇒ 我干净退出
  //         死了  ⇒ 崩溃残留 ⇒ 接管（删掉重建）
  //
  //   ⚠ 踩过的第二个坑（并发实测当场抓出来的）：
  //     独占创建成功 ⇒ **文件已经存在但内容还没写**（open 与 write 之间有个窗口）
  //     ⇒ 此刻另一个进程读到**空内容** ⇒ parseLock 返回 null
  //     ⇒ 若把它当"残留锁"直接删掉重建，就会**删掉赢家正在写的锁** ⇒ 两个都跑。
  //   ⇒ 正解：**读不到 pid 时不许立刻当成残留** ——
  //     ① 先**重试读**几次（对方可能正在写）；
  //     ② 还是读不到 ⇒ 看文件**年龄**：很新（< 2 秒）⇒ 是"正在创建"⇒ **让给人家**（干净退出）；
  //        很久 ⇒ 才当残留。
  //   ⛔ 宁可漏，不可冤：宁可这次不接管，也绝不能删掉一个活实例的锁。
  // ══════════════════════════════════════════════════════════════════════
  const sleepSync = (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch { /* 拿不到就退化成空转 */ }
  };
  const writeLock = () => {
    const fd = fs.openSync(file, 'wx');           // ★ 独占创建：EEXIST 就是别人拿着
    try {
      fs.writeSync(fd, process.pid + '|' + Date.now());
    } finally {
      fs.closeSync(fd);
    }
  };
  const readRaw = () => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  };
  const fileAgeMs = () => {
    try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return Infinity; }
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return { ok: false, why: '建目录失败：' + String((e && e.message) || e) };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      writeLock();                                  // ★ 抢：一次成功就是唯一实例
      return { ok: true, why: '锁已拿到（pid ' + process.pid + '，独占创建）', holder: process.pid };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        return { ok: false, why: '写锁文件失败：' + String((e && e.message) || e) };
      }
      // ── EEXIST：别人已经建了 ──
      let l = null, raw = '';
      for (let t = 0; t < 8; t++) {                 // ① 重试读：对方可能正在写内容
        raw = readRaw();
        l = parseLock(raw);
        if (l) break;
        sleepSync(30);
      }
      if (l) {
        if (pidAliveFn(l.pid)) {
          return { ok: false, why: '哨兵 pid ' + l.pid + ' 还活着 ⇒ 已有实例在跑', holder: l.pid };
        }
        // 锁是崩溃残留 ⇒ 接管
        try { fs.unlinkSync(file); } catch { /* 可能被别人抢走了 */ }
        continue;                                   // 回到循环重抢
      }
      // ② 还是读不到 pid：看年龄。很新 ⇒ 人家正在创建 ⇒ 让给人家。
      const age = fileAgeMs();
      if (age < 2000) {
        return { ok: false, why: '锁文件刚被创建（' + Math.round(age) + 'ms 前、内容还没写完）⇒ 已有实例正在启动，本进程让出' };
      }
      // ③ 很久了还读不到 ⇒ 当残留
      try { fs.unlinkSync(file); } catch { /* 可能被别人抢走了 */ }
      continue;
    }
  }
  return { ok: false, why: '连续 ' + 3 + ' 次抢锁都没拿到 ⇒ 已有实例在跑，本进程不启动' };
}

/**
 * 释放锁（只删**自己**的锁；不删别人的）。
 * @param {string} file
 */
function releaseLock(file) {
  try {
    const l = parseLock(fs.readFileSync(file, 'utf8'));
    if (l && l.pid !== process.pid) return false;   // 别人的锁，不碰
    fs.unlinkSync(file);
    return true;
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-02 15:10 新增：**自动动作的成功/失败计数 + 升级报警**
//
//   【为什么加这个 —— 本轮最贵的一课】
//   哨兵的「自动压缩」坏了整整一下午（TDZ：`const r = await rpc(..., {agentId: r.sessionId})`），
//   一个会话都没压过。但日志里它只是**每轮一行**：
//       ⤵ 自动压缩 → 视频工作流  126k → 126k tok  ✗ Cannot access 'r' before initialization
//   被当成"偶发失败"忽略了。宿主看到的是"会话越积越满"，我却在调阈值。
//
//   ⇒ 铁律：**静默失败的机械动作最贵。**
//     任何定时/自动动作必须有**成功计数**；连续失败要**升级成显眼报警**，
//     ⛔ 不能只记一行日志就算了。
//
//   判据设计（⚠ 注意：不能写成"快照"，要看**关系**）：
//     · 每个动作维护 { fail 连续失败次数, ok 累计成功, lastErr 最近错误 }
//     · 成功一次 ⇒ fail 归零（**这是关键：自动恢复后要自动降级，不能永久报警**）
//     · fail 达到 FAIL_ALERT_N（默认 3） ⇒ **升级**：写 _待办.md + 打醒目横幅 + 日志首行
//     · 已经报警过就不再重复写（每 6h 最多提醒一次），但 fail 继续累加
//     · 全绿时如果之前报过警 ⇒ 打一条"已恢复"并撤销待办标记
//
//   ⛔ 反面教材：`if (失败) 记一笔` 这种写法就是本轮的病根 —— 记了，但没人看得见。
// ══════════════════════════════════════════════════════════════════════════
const FAIL_ALERT_N = Math.max(2, Number(val('--失败报警', 3)));   // 连续失败几次升级
const FAIL_STATE_KEY = 'actionHealth';                              // state 里的键名
/** 时间戳（顶层作用域版）。⚠ 不能在顶层直接用 main() 里那个 now2 —— 作用域拿不到（自测抓到过）。 */
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

/** 记一次自动动作的结果。ok=true 清零，ok=false 累加并可能升级报警。 */
function recordAction(state, action, ok, err) {
  const all = state[FAIL_STATE_KEY] || {};
  const a = all[action] || { fail: 0, ok: 0, lastErr: '', alertedAt: 0 };
  if (ok) {
    a.ok = (a.ok || 0) + 1;
    // ★ 成功即清零 —— 自动恢复必须自动降级，否则报警永久亮着就没人信了
    if (a.fail > 0) console.log('[' + ts() + '] ✓ 自动动作恢复：「' + action + '」连续失败 ' + a.fail + ' 次后成功');
    a.fail = 0;
    a.lastErr = '';
  } else {
    a.fail = (a.fail || 0) + 1;
    a.lastErr = String(err || '').slice(0, 300);
  }
  all[action] = a;
  state[FAIL_STATE_KEY] = all;
  return a;
}

/** 连续失败达标的动作 ⇒ 返回要升级报警的清单 */
function failingActions(state) {
  const all = state[FAIL_STATE_KEY] || {};
  const out = [];
  for (const [name, a] of Object.entries(all)) {
    if ((a.fail || 0) >= FAIL_ALERT_N) out.push({ name, ...a });
  }
  return out;
}

/**
 * 升级报警：写进 _待办.md（宿主会看到）+ 打醒目横幅。
 * ⚠ 幂等：每个动作 6 小时内只写一次待办，避免刷屏。
 */
function alertFailing(state, now) {
  const bad = failingActions(state);
  if (!bad.length) return 0;
  const SIX_H = 6 * 3600 * 1000;
  let wrote = 0;
  for (const b of bad) {
    if (b.alertedAt && (now - b.alertedAt) < SIX_H) continue;
    const line = '- [ ] ⛔ 自动动作连续失败 ' + b.fail + ' 次：**' + b.name + '** → `'
      + b.lastErr.replace(/\|/g, '/').slice(0, 160) + '`（看 `引擎\\.tmp\\session-sentinel.log`）';
    try {
      const f = path.join(SHARED_MEM, '_待办.md');
      const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      const key = '自动动作连续失败 ' + b.fail + ' 次：**' + b.name + '**';
      if (!t.includes(key)) fs.appendFileSync(f, (t && !t.endsWith('\n') ? '\n' : '') + line + '\n', 'utf8');
      wrote++;
    } catch { /* 写不进也不能挡主流程 */ }
    state[FAIL_STATE_KEY][b.name].alertedAt = now;
  }
  if (wrote) {
    console.log('\n' + '█'.repeat(70));
    console.log('█ ⛔⛔ 哨兵自动动作故障报警');
    for (const b of bad) {
      console.log('█   · ' + b.name + '  连续失败 ' + b.fail + ' 次（累计成功 ' + (b.ok || 0) + ' 次）');
      console.log('█     最近错误：' + String(b.lastErr).slice(0, 200));
    }
    console.log('█ ⇒ 这不是偶发，是**功能坏了**。继续跑一万轮也不会自己好。');
    console.log('█ ⇒ 已写进 `_共享记忆\\_待办.md`。排查：看 `引擎\\.tmp\\session-sentinel.log`。');
    console.log('█'.repeat(70) + '\n');
  }
  return bad.length;
}

/**
 * 真实成本取值 —— **必须和引擎 UI 的算法逐字一致**，否则哨兵和宿主看到的不是同一个数。
 *
 * 引擎源码（`app.asar` 内 `contextOccupancy`）原文：
 *   `const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;`
 *   ⇒ **`??`（只有 null/undefined 才兜底），⛔ 不是 `||`（把 0 也当"没有"）**。
 *
 * ★ 2026-11-03 12:35：把老写法 `Number(cp.projectedTokens) || Number(cp.pressureTokens) || 0`
 *   改成与引擎一致的 `??` 语义。
 *
 * ⚠ **诚实定位：这是"消除分歧"，不是"修一个正在害人的 bug"。**
 *   两种写法只在 `projectedTokens` **恰好等于 0** 时才分叉（非零小值如 433 两边都取 433）。
 *   实测（探针-精确核实.mjs，12:45 全量 62 个会话）：
 *     · 全部会话里分叉 **3 个**，但**全是已归档**（96de83 / 7e7d61 / dd29b2）；
 *     · **活会话分叉 0 个**。
 *   ⇒ 所以它**没有**造成过"压完再压"；真要说风险，是**潜在**的：
 *     压缩刚结束、`projectedTokens` 恰好为 0 的那一瞬，`pressureTokens` 还冻在
 *     压缩前最后一次请求的读数（压缩本身不报 usage）⇒ `||` 会读到那个旧值，
 *     让哨兵以为"还满着"，对着一个 0% 的会话继续问/继续压。
 *   实测到的"冻住"现象是真的：命令会话 3d047f 压缩后 `pressureTokens` 一直是 256946，
 *   而 `projectedTokens` 是 433 —— 只是 433 非零，`||` 侥幸没踩中。**不能靠侥幸**。
 *
 * @param {{projectedTokens?:number, pressureTokens?:number}|null|undefined} cp contextPressure 原对象
 * @returns {number} 真实成本（tok）；两者都不可用时返回 0（安全方向：不会被误判成超线）
 */
function pickCost(cp) {
  const p = Number(cp && cp.projectedTokens);
  if (Number.isFinite(p)) return p;              // ⛔ 不判 0、不判真假 —— 引擎是 ??，我们也必须是 ??
  const q = Number(cp && cp.pressureTokens);
  return Number.isFinite(q) ? q : 0;
}

/**
 * **三档水位的唯一判据** —— 显示（`--看` 的表格/结论区）和动作（B 段）都从这一个函数取档。
 *
 * ★★ 2026-11-03 12:41 为什么必须抽出来：
 *   同一套阈值在文件里被**抄成了三份 if 链**，其中两份写反了，而且**都只错在显示层**，
 *   所以 `--自测` 全绿、哨兵照常干活，人看 `--看` 却得到相反结论：
 *     ① `render()` 里判序写成 收尾(200k) 在 压缩(240k) 之前 ⇒ ≥240k 全被标成"该写收尾"，
 *        `⤵该压缩` 这一档**永远不显示**；
 *     ② `--看` 结论区 `warn` 只有下界、`compact` 又写了 `proj < COST_WARN(<200k)`
 *        ⇒ 两个集合**交集恒为空**，`⤵ 该压缩的` 那一节**一行都打不出来**。
 *   实测证据：命令会话 256946 tok（86% 窗口）时，`--看` 只说"该写收尾"，一个字没提压缩。
 *   ⇒ 教训（和判据工程那条同源）：**阈值比较的"顺序"本身就是判据**，
 *     抄三份就一定有某一份会写反。抽成一个函数，自测直接正反打这个函数。
 *
 * @param {number} cost 真实成本 tok（＝ pickCost 的结果）
 * @param {number} win  窗口 tok（0/缺失 ⇒ 不判交接档）
 * @returns {'handover'|'compact'|'warn'|'none'}
 */
function waterLine(cost, win) {
  const c = Number(cost);
  const w = Number(win);
  if (!Number.isFinite(c)) return 'none';
  // 从**最高**的线往下比，命中即返回 —— ⛔ 顺序不许换（换了下档永远抢不到）
  if (Number.isFinite(w) && w > 0 && c >= w * COST_GATE_RATIO) return 'handover';
  if (c >= COST_COMPACT) return 'compact';
  if (c >= COST_WARN) return 'warn';
  return 'none';
}

/** 取一轮快照：每个会话的 running / 压力 / 标题 */
async function snapshot(cookie) {
  const sl = await rpc(cookie, 'session/list', { _request: {} });
  const items = (sl && sl.result && sl.result.ok && sl.result.value && sl.result.value.items) || [];
  const scenes = loadScenes();
  return items.map((it) => {
    const v = (it.projections && it.projections.values) || {};
    const cp = v.contextPressure || {};
    const win = cp.contextWindow || 0;
    // ★ 判据字段：**pickCost(cp)**，和引擎 UI 的 `projectedTokens ?? pressureTokens` 逐字一致
    //   ⛔ 绝不用 surfaceTokens（0.881，漏掉请求+回复压力）
    //   ⛔ 绝不用 `||` 兜底 —— 压缩后 projectedTokens 会塌到几百，`||` 会把它当"没有"去读冻住的旧值（见 pickCost 注释）
    const proj = pickCost(cp);
    const pct = win ? Math.round((proj / win) * 100) : null;
    const meta = scenes.get(it.sessionId) || {};
    // ★ 2026-11-02：判断这个会话是不是"活着的面板"。
    //   不在任何场景 json 里的会话 = 已归档（标题里也常带「已归档」）⇒ **不推任何提醒**。
    //   原因：归档会话已经收工了，给它发"该压缩/该换会话"没有任何人能执行，
    //   只会让日志和推送里全是噪音（原来一次干跑就推给了 3 个归档会话）。
    const archived = !meta.scene && /已归档/.test(String(v.title || ''));
    return {
      sessionId: it.sessionId,
      title: v.title || (v.title) || meta.sessionTitle || it.sessionId.slice(-6),
      scene: meta.scene || '',
      panel: meta.panel || '',
      panelId: meta.panelId || '',
      archived,
      running: !!it.running,
      pct,
      proj, win,
      turns: (v.sessionStats && v.sessionStats.turns) || 0,
      // ★★★ 2026-11-02 三期移植·一期：**判活的唯一依据 = 三个累计量的增量** ★★★
      //   steps   —— 已完成的步数
      //   toolMs  —— 工具执行累计耗时
      //   llmMs   —— 模型调用累计耗时
      //   三者都是**单调累加**的，只要在增长就说明引擎真的在推进工作。
      //   （路径：item.projections.values.sessionStats —— ⚠ 不是 item.sessionStats，
      //     此前"该字段不可用"的结论是**读错了路径**，已纠正。）
      progress: {
        steps: Number(v.sessionStats && v.sessionStats.steps) || 0,
        // ★ 2026-11-03 18:10：步数闸/输出量闸要用的**累计输出 token**。
        //   ⚠ 引擎的 sessionStats 里**没有** outputTokens，只有 decodeTokens（实测字段表：
        //   turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens）。
        //   decodeTokens 是**累计解码输出量**，正是"每轮输出多少 token"的分子。
        decodeTokens: Number(v.sessionStats && v.sessionStats.decodeTokens) || 0,
        toolMs: Number(v.sessionStats && v.sessionStats.toolMs) || 0,
        llmMs: Number(v.sessionStats && v.sessionStats.llmMs) || 0,
      },
      // ⚠ 会话文件 MB —— **只用于显示**，⛔ 不参与任何判据
      //   实测与真实成本负相关 -0.380（文件越大反而越便宜），详见 工具\_量纲对拍.mjs
      mb: sessionFileMB(it.sessionId),
      // ★ 2026-11-01 加 / 2026-11-02 三期改：updatedAt = 引擎最后一条事件的时间戳。
      //   ⛔⛔ **不参与判活** —— 实测它不是心跳：steps 从 431 涨到 434 的 12 分钟里，
      //   它一直冻在 16:06:26。判活统一走 `progress`（steps/toolMs/llmMs 增量）。
      //   它在这里**只做「最后事件时间」显示**，别再拿它写任何 if。
      updatedAt: Number(it.updatedAt) || 0,
      // ★ 2026-11-02 23:00 加：turnOutline 是引擎自己维护的"每轮一句话提纲"。
      //   用途只有一个 —— **判断会话有没有回应哨兵的「压缩前落盘」询问**（看暗号在不在）。
      //   ⚠ prompt 是全文，response 是引擎截断过的摘要；暗号很短，摘要里一定留得住。
      outline: Array.isArray(v.turnOutline) ? v.turnOutline : [],
      // openStep.startTime = 当前这一步开始的时刻（引擎 sessionStats 里带的），
      //   比哨兵自己记的 startedAt 更准；拿不到再退回 startedAt。
      stepStartAt: Number(v.sessionStats && v.sessionStats.openStep && v.sessionStats.openStep.startTime) || 0,
      isSelf: it.sessionId === SELF_ID,
    };
  });
}

function render(rows) {
  console.log('\n' + '─'.repeat(126));
  console.log('  ' + '会话'.padEnd(20) + '状态'.padEnd(12) + '成本'.padEnd(10) + '窗口占比'.padEnd(12) + '文件(参考)'.padEnd(12) + '轮次'.padStart(5) + '  步数  最后事件      闸门');
  console.log('  ' + '─'.repeat(122));
  for (const r of rows.sort((a, b) => (b.proj || 0) - (a.proj || 0))) {
    // 2026-11-02 修：原来 isSelf 一律显示「（我）思考中」——那是假的，我现在可能明明空闲。
    const state = (r.running ? '🔥 思考中' : '💤 空闲') + (r.isSelf ? '（我）' : '');
    const mbTxt = r.mb === null ? '?' : r.mb.toFixed(2) + ' MB';
    const costTxt = Math.round(r.proj / 1000) + 'k';
    const pctTxt = r.win ? Math.round((r.proj / r.win) * 100) + '%' : '?';
    // ★ 三期移植·一期：步数是**判活依据**，这里显示出来方便人肉核对
    const stepsTxt = String((r.progress && r.progress.steps) || 0);
    // ⛔ updatedAt 只显示，不参与任何判断
    const evTxt = r.updatedAt ? new Date(r.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
    let gate = '—';
    // ★ 判据 = 真实成本（pickCost = projectedTokens ?? pressureTokens），⛔ 不是文件 MB（实测负相关 -0.380）
    // ★★ 2026-11-03 12:40 修**判序写反**：老代码把 收尾线(200k) 写在 压缩线(240k) 之前，
    //   于是 ≥240k 的会话全部先命中 200k 那条 ⇒ `⤵该压缩` **永远显示不出来**，
    //   人看 `--看` 就以为"哨兵根本没管压缩线"。现在统一走 waterLine（唯一真源）。
    switch (waterLine(r.proj, r.win)) {
      case 'handover': gate = '★兜底交接（压缩过仍超）'; break;
      case 'compact': gate = '⤵该压缩'; break;
      case 'warn': gate = '⚠ 该写收尾'; break;
      default: gate = '—';
    }
    console.log('  ' + ((r.scene || '(无场景)') + '·' + r.title).slice(0, 18).padEnd(20)
      + state.padEnd(12) + costTxt.padEnd(10) + pctTxt.padEnd(12) + mbTxt.padEnd(12)
      + String(r.turns).padStart(5) + stepsTxt.padStart(7) + '  ' + evTxt.padEnd(13) + gate);
  }
  console.log('  （步数 = 累计 step 数，是判活依据；「最后事件」= updatedAt，⛔ 只做显示，不参与判活）');
}

/**
 * --闸自测：端到端验「验证闸」的两块**真动作**，不是算法。
 *   ① topicSnap 真能看见磁盘上的 `NN_*.md`（新建的立刻看见、mtime 真前进）
 *   ② 项目本地化体检.mjs 真能被 spawnSync 调起来、真能数出违规
 *      —— 正例：程序开发（应 0 违规）；反例：现场造一个"有文档但没进索引"的目录（应 ≥1）
 * ⛔ 只造在 `D:\Lintax数据\_tmp\_闸自测\` 下，跑完删掉，绝不碰真场景。
 */
async function gateSelfTest() {
  const fsx = fs;
  const stamp = Date.now();
  const sand = path.join('D:', 'Lintax数据', '_tmp', '_闸自测', String(stamp));
  const info = path.join(sand, '项目信息');
  fsx.mkdirSync(info, { recursive: true });
  let bad = 0, n = 0;
  const ck = (name, got, want) => {
    n++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad++;
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   得到=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(want)));
  };
  try {
    // ① 空目录 ⇒ count 0
    ck('空的项目信息 ⇒ 0 篇', topicSnap('x', info).count, 0);
    // ② 写一篇 NN_*.md ⇒ 立刻看见 1 篇
    const d1 = path.join(info, '01_测试主题.md');
    fsx.writeFileSync(d1, '# 测试\n', 'utf8');
    ck('新建 01_测试主题.md ⇒ 1 篇', topicSnap('x', info).count, 1);
    // ③ readme / 索引 不算主题文档（排除规则）
    fsx.writeFileSync(path.join(info, 'readme.md'), '# r\n', 'utf8');
    fsx.writeFileSync(path.join(info, '索引.md'), '# i\n', 'utf8');
    ck('readme.md / 索引.md 不计入', topicSnap('x', info).count, 1);
    // ④ 子目录（= 已登记项目档案）也扫得到
    const sub = path.join(info, '某项目');
    fsx.mkdirSync(sub, { recursive: true });
    fsx.writeFileSync(path.join(sub, '02_子项目主题.md'), '# 子\n', 'utf8');
    const s2 = topicSnap('x', info);
    ck('子目录里的一篇也扫得到 ⇒ 2 篇', s2.count, 2);
    // ⑤ mtime 关系：改一篇 ⇒ maxMtime 前进（这是闸判"真写过"的依据）
    const t0 = topicSnap('x', info).maxMtime;
    const later = new Date(Date.now() + 5000);
    fsx.writeFileSync(d1, '# 测试改了\n', 'utf8');
    fsx.utimesSync(d1, later, later);
    ck('改一篇后 mtime 前进 ⇒ diskChangedSinceAsk 为真', diskChangedSinceAsk({ count: 2, maxMtime: t0 }, topicSnap('x', info)), true);
    // ⑥ 快照相同 ⇒ 假（关系判据必须能失败）
    ck('快照相同 ⇒ 不算落盘', diskChangedSinceAsk({ count: 2, maxMtime: t0 }, { count: 2, maxMtime: t0 }), false);

    // ⑦ 真体检：正例 —— 程序开发 应 0 违规
    const hGood = await projectHealthBad('程序开发');
    console.log('  · 体检(程序开发) => bad=' + hGood.bad + (hGood.where ? '  ' + hGood.where.slice(0, 160) : ''));
    ck('真体检能跑起来（不是 -1）', hGood.bad >= 0, true);
    ck('程序开发 体检 0 违规 ⇒ 闸对该场景可放行', hGood.bad, 0);

    // ⑧ 端到端：答案闸对着**真场景、真磁盘、真体检**跑一遍（只读，不写任何真文件）
    //   ⚠ 每个用例都必须带 askSeq + 一条 seq 更大的回答轮 —— 这是 10:45 之后判"这次回答"的地基，
    //     没有 askSeq = 老 state = 一律当没回（宁可拦，不许假绿）。
    const realSnap = topicSnap('程序开发');
    const ansOk = (tag) => ({ outline: [{ seq: 50, prompt: 'q', response: tag }] });
    // ★★ 2026-11-03 16:45：闸的地基现在是"**我真问过**"⇒ 每个样本都必须带 askAt + askedN。
    //   （不带的样本会被**正确**拦下 —— 那正是第 ① 条判据在起作用，不是自测写错了。）
    const asked = (extra) => ({ askAt: Date.now(), askedN: 1, askSeq: 10, askResp: '', ...extra });
    //   反例 A：回【已落盘】但提问后什么都没变 ⇒ 必须拦
    const gA = await answerGateCheck({ scene: '程序开发', ...ansOk('【已落盘】') },
      asked({ askDocs: realSnap }));
    console.log('  · 端到端A（假落盘）=> allow=' + gA.allow + '  why=' + gA.why);
    ck('端到端：真场景 + 回【已落盘】+ 文档没动 ⇒ 拦', gA.allow, false);
    //   正例 B：回【无需落盘】⇒ 必须放行
    const gB = await answerGateCheck({ scene: '程序开发', ...ansOk('【无需落盘】') },
      asked({ askDocs: realSnap }));
    console.log('  · 端到端B（无需落盘）=> allow=' + gB.allow + '  why=' + gB.why);
    ck('端到端：真场景 + 回【无需落盘】⇒ 放行', gB.allow, true);
    //   正例 C：提问时是空的，后来真有 7 篇 ⇒ 必须放行（这是"真落盘"的样子）
    const gC = await answerGateCheck({ scene: '程序开发', ...ansOk('【已落盘】') },
      asked({ askDocs: { count: 0, maxMtime: 0, names: [] } }));
    console.log('  · 端到端C（真落盘）=> allow=' + gC.allow + '  why=' + gC.why + '  文档=' + gC.nowDocs.count + ' 篇');
    ck('端到端：真场景 + 提问后确实多了文档 + 体检 0 违规 ⇒ 放行', gC.allow, true);
    //   反例 D：认不出场景（没有 scene）⇒ 必须拦，⛔ 不许因为 includes('') 恒真而放行
    const gD = await answerGateCheck({ scene: '', ...ansOk('【已落盘】') },
      asked({ askDocs: { count: 0, maxMtime: 0, names: [] } }));
    console.log('  · 端到端D（认不出场景）=> allow=' + gD.allow + '  why=' + gD.why);
    ck('端到端：认不出场景 ⇒ 拦', gD.allow, false);
    ck('端到端：认不出场景时，理由必须指向"认不出场景"（不许甩锅给"文档没变"）',
      /认不出场景/.test(gD.why), true);
    //   ★★ 2026-11-03 16:45 · 派单第 ① 条：**没问过 ⇒ 一律拦**（事故原样）
    const gH = await answerGateCheck({ scene: '程序开发', ...ansOk('【已落盘】') },
      { askAt: 0, askedN: 0, askSeq: 4044, askResp: '', askDocs: realSnap });
    console.log('  · 端到端H（没问过）=> allow=' + gH.allow + '  why=' + gH.why);
    ck('端到端：没问过（askAt=0 askedN=0）⇒ 拦（16:29 事故原样）', gH.allow, false);
    ck('端到端：没问过时，理由必须说清"没问就不算回话"',
      /没问就不算回话/.test(gH.why), true);
    //   反例 F：**老 state（没 askSeq）** + 回【无需落盘】⇒ 必须拦（不知道基准，不开闸）
    const gF = await answerGateCheck({ scene: '程序开发', ...ansOk('【无需落盘】') }, { askDocs: realSnap });
    console.log('  · 端到端F（老 state 没 askSeq）=> allow=' + gF.allow + '  why=' + gF.why);
    ck('端到端：老 state 没有 askSeq ⇒ 拦（宁可再问一次，不拿没基准的暗号开闸）', gF.allow, false);
    //   反例 E：真场景 + 回【已落盘】+ 文档没动 + **该场景体检有违规** ⇒ 理由要点出体检
    //   （用假 issues 直打判据，避免为了造红去污染真目录）
    ck('端到端：体检有 1 条违规时，理由要点出体检而不是只说文档',
      compactGateVerdict({ tag: '【已落盘】', diskChanged: true, healthBad: 1, healthWhere: '程序开发（场景根）：x' }).why,
      '项目本地化体检没过（违规 1 条）：程序开发（场景根）：x');
  } finally {
    try { fsx.rmSync(sand, { recursive: true, force: true }); } catch { /* 删不掉也不影响判据 */ }
  }
  console.log('\n闸自测：' + (n - bad) + '/' + n + (bad ? ' ✗ 有 ' + bad + ' 条不符' : ' ✓ 全过'));
  console.log('（只为「算法+真文件+真体检」守门；压缩阈值/落盘暗号由 --自测 守）');
  return bad ? 1 : 0;
}

async function main() {
  // ★ 2026-11-08：① 立即止血 —— 真读 余量.mjs --json --全部 当场实测，清掉陈旧队列项（不推、不换）
  if (has('--换会话复算')) return await handoverRecheckOnce();
  // ★ 2026-11-07：换会话链路**干跑复算**（不连引擎 / 不推消息 / 不写盘），把 7 步都打出来
  if (has('--换会话干跑')) return await handoverDryRun();
  // ★ --自测：只验判据，不连引擎、不读 cookie、不碰任何文件
  if (has('--自测')) return await selfTest();

  // ★ --闸自测：**端到端**验「验证闸」—— 建真目录、写真文档、跑真体检命令。
  //   ⚠ 为什么要单独一条：纯函数自测只能证明"算法对"，证明不了
  //     「topicSnap 真能看见文件」「项目本地化体检.mjs 真能被 spawnSync 调起来」。
  //     2026-11-03 之前吃过这个亏：判据全绿但工具根本没被执行（TDZ / .cmd spawn 静默 null）。
  //   ⛔ 只在 `D:\Lintax数据\_tmp\闸自测-<时间戳>\` 里造，**绝不碰任何真场景目录**。
  if (has('--闸自测')) return gateSelfTest();

  // ★ --票据：只看"台账里各会话名下有哪些单"（收工催回执的数据源，排障用）
  //   ⚠ 它不连引擎、不推任何消息 —— 纯读。
  if (has('--票据')) {
    const m = await loadTicketsBySession();
    if (!m.size) { console.log('（读不到台账，或台账为空）'); return 0; }
    for (const [sid, arr] of m) {
      const open = arr.filter((t) => !t.done).length;
      console.log(sid + '  共 ' + arr.length + ' 单 · 未回执 ' + open);
      for (const t of arr) console.log('   ' + (t.done ? '✅' : '❌') + ' ' + t.ts + '  ' + String(t.head || '').slice(0, 50));
    }
    return 0;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ★ 单实例锁（2026-11-03 16:45 · 派单第 ④ 条）
  //
  //   放在 `--看` 分支**之前**是不行的 —— --看 是只读查询模式，
  //   它要是占了锁，真哨兵会被挡在门外。（--自测/--闸自测 已在上面 return掉了。）
  //
  //   ⚠ --干跑（DRYRUN）：**不占锁**。干跑只打印判据、不做任何自动动作，
  //     它要是占了锁，真哨兵会被挡在门外 ⇒ 更糟。（11:45 那次"干跑伪造心跳"是同一类事故。）
  // ══════════════════════════════════════════════════════════════════════
  if (WATCH && !DRYRUN) {
    const lk = takeLock(LOCK_FILE);
    if (!lk.ok) {
      // ⛔ 拿不到锁 = 已经有哨兵在跑 ⇒ **干净退出**，只写一行日志，不推任何消息、不碰任何会话。
      const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] '
        + '⛔ 已有哨兵实例在跑（' + lk.why + '）⇒ 本进程不启动，直接退出';
      console.log(line);
      try {
        fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
        fs.appendFileSync(path.join(ROOT, '引擎', '.tmp', 'session-sentinel.log'), line + '\n');
      } catch { /* 写不进不影响结论 */ }
      return 0;
    }
    console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] 🔒 单实例锁已拿到：' + lk.why);
    // 退出时把锁还回去（只删自己的）
    const bye = () => { releaseLock(LOCK_FILE); };
    process.on('exit', bye);
    process.on('SIGINT', () => { bye(); process.exit(0); });
    process.on('SIGTERM', () => { bye(); process.exit(0); });
  }

  await ensureCookie(true);
  if (!COOKIE) {
    // ★ 2026-11-02 23:50 修（注入测试打出来的第二个"一启动就死"入口）：
    //   原来这里直接 `process.exit(1)` —— 工作台刚重启 / 引擎还没起好时启动哨兵，
    //   它就是**一行日志都来不及写就死了**，看门狗还以为拉起过。
    //   实测：DSH_PORT 指到不存在的端口 ⇒ `✗ 拿不到引擎 cookie ⇒ 引擎没跑？` + exit 1。
    //   ⇒ 只有在**交互查看模式**（--看）才允许直接退出（那时人在等结果，退出是对的）；
    //     常驻模式（--盯）必须**继续等**，每轮重试 ensureCookie，直到引擎起来为止。
    if (!WATCH) { console.error('✗ 拿不到引擎 cookie ⇒ 引擎没跑？'); process.exit(1); }
    console.error('⚠ 拿不到引擎 cookie（引擎可能还没起好）⇒ 常驻模式继续等，每轮重试');
  }

  if (LOOK) {
    const rows = await snapshot(COOKIE);
    // ⚠ 列表全打（含归档，方便排查），但**建议只对活着面板给** ——
    //   已归档会话已经收工了，给它"该压缩/该收尾"没有任何人能执行，纯噪音。
    const live = rows.filter((r) => !r.archived);
    render(live);
    // ★★ 2026-11-03 12:41 修**三档 filter 互相打架**（和 render 里那个是同一种病，两处一起改）：
    //   `warn` 的条件只有下界（≥200k），没有上界 ⇒ 240k 以上的会话**同时**进 warn 和 compact，
    //   但 `compact` 的条件又写了 `proj < COST_WARN`（= <200k）⇒ **两个集合交集为空**，
    //   `⤵ 该压缩的` 那一节**任何情况下都不会打印一行**。
    //   实测证据：12:30 命令会话 256946（86%）时，--看 的结论区只有"该开始写收尾"，没有"该压缩"。
    //   ⇒ 正解：三档一律走 waterLine（唯一真源），互斥且从高到低。
    const of = (k) => live.filter((r) => waterLine(r.proj, r.win) === k);
    const gate = of('handover');
    if (gate.length) {
      console.log('\n  ★ 兜底交接候选（成本 ≥ 窗口 ' + Math.round(COST_GATE_RATIO * 100) + '% —— 且验证过压缩治不了）：');
      for (const r of gate) console.log('    · ' + r.scene + '·' + r.title + '  ' + Math.round(r.proj / 1000) + 'k (' + Math.round(r.proj / r.win * 100) + '% 窗口, ' + r.turns + ' 轮)');
    }
    const compact = of('compact');
    if (compact.length) {
      console.log('\n  ⤵ 该压缩的（成本 ≥ ' + Math.round(COST_COMPACT / 1000) + 'k —— 先落盘询问，过了验证闸才 /compact）：');
      for (const r of compact) console.log('    · ' + r.scene + '·' + r.title + '  ' + Math.round(r.proj / 1000) + 'k'
        + (r.win ? ' (' + Math.round(r.proj / r.win * 100) + '% 窗口)' : '') + (r.running ? '  🔥在跑⇒等停手' : ''));
    }
    const warn = of('warn');
    if (warn.length) {
      console.log('\n  ⚠ 该开始写收尾的（成本 ≥ ' + Math.round(COST_WARN / 1000) + 'k 且未到压缩线 —— 把 §〇 写新鲜，⛔ 不是换人）：');
      for (const r of warn) console.log('    · ' + r.scene + '·' + r.title + '  ' + Math.round(r.proj / 1000) + 'k (' + r.turns + ' 轮)');
    }
    const running = live.filter((r) => r.running);
    console.log('\n  🔥 正在思考：' + (running.length ? running.map((r) => r.scene || r.title).join('、') : '（无）'));
    console.log('  💤 空闲：' + live.filter((r) => !r.running).length + ' 个（空闲也照管，超线就动手）');
    console.log('  （已归档 ' + (rows.length - live.length) + ' 个已排除，不给它们任何建议）');
    return 0;
  }

  // ── 监看模式 ──
  console.log('════ 会话哨兵 ────  间隔 ' + INTERVAL + 's（默认 3 分钟一轮）');
  if (USE_OLD_NUDGE) {
    console.log('   【干活中】催进度（旧三档·回退模式）：10 分钟问进度 → 20 分钟请加速 → 30 分钟要它自评');
    console.log('              ⛔ 不逼它砍需求、不要求"最小可用版本"；30 分钟档之后不再催');
  } else {
    console.log('   【干活中】收口闸门：' + Math.round(STOP_MAX_SEC / 60) + ' 分钟硬上限 ⇒ 投一句「停，给结论」，同一轮只投一次');
    console.log('              ⛔ 不发 10/20/30 分三档催办、不塞提示层；全绿提前停：'
      + (ENABLE_EARLY_STOP ? '开' : '关（收工自检恒红）'));
  }
  console.log('              疑似卡死：' + (STALL_SEC / 60) + ' 分钟**累计量零增长**才报（副线）');
  console.log('                判据 = steps / toolMs / llmMs 任一涨 ⇒ 有进展；⛔ 不用 updatedAt（实测不是心跳）');
  console.log('   【已停手】压缩 ≥ ' + Math.round(COST_COMPACT / 1000) + 'k tok · 写收尾 ≥ ' + Math.round(COST_WARN / 1000)
    + 'k tok · 兜底交接 ≥ 窗口 ' + Math.round(COST_GATE_RATIO * 100) + '%（且压缩过仍超）');
  console.log('   ★ 判据 = **真实成本 projectedTokens ?? pressureTokens**（与引擎 UI 同算法）');
  console.log('     ⛔ 不是会话文件 MB —— 实测相关性 **-0.380**（负相关），按它判断会反过来压错人');
  console.log('     ⛔ 交接（fork）不降成本（实测前后两代 tok 完全相同）⇒ 超线只代表"该压缩"，不代表"该换人"');
  console.log('   ⛔ 过线但还在干活 ⇒ 只排队不打断，等它停手再提');
  console.log('   ★ 不设时间冷却：**空闲满 ' + Math.round(IDLE_BEFORE_COMPACT_MS / 60000)
    + ' 分钟 且 过压缩线 ⇒ 立刻问 → 过闸 → 压**（压缩失败才退避 ' + Math.round(COMPACT_RETRY_MS / 60000) + ' 分钟重试）'
    + '；兜底交接面板冷静 ' + Math.round(REPEAT_GATE_MS / 3600000) + 'h'
    + (DRYRUN ? ' · 【干跑，不真发】' : ''));
  console.log('（Ctrl+C 结束）\n');

  const state = readState();
  let round = 0;
  let lastTellAt = 0;          // 上次「我在岗」自报的时间（现在 30 分钟才说一次）

  // ★ 2026-11-02 22:56 修一个**会让看门狗误杀活哨兵**的 bug：
  //   原来心跳只在 tick() 开头写一行 ⇒ 心跳间隔 = 轮询间隔(180s) + tick 自身耗时。
  //   实测 22:49:55 → 22:55:55 = **360 秒**，而 `启动哨兵.cmd` 的判死线是 **300 秒**
  //   ⇒ 每一轮都判定"哨兵已死" ⇒ 反复拉起，多个哨兵同时抢着压缩同一个会话。
  //   ✅ 正解：心跳用**独立定时器**，60 秒一次，跟 tick 死活、引擎连不连得上都无关。
  //      它只证明"这个进程还活着"，这正是看门狗唯一需要知道的事。
  const beat = () => {
    // ★★ 2026-11-03 11:45 修「干跑伪造心跳 ⇒ 守护拉起第二个哨兵」：
    //   实测：11:34:17 守护报「心跳还新但 pid 15308 已不存在」⇒ 拉起 35036，
    //   而真哨兵 30752 **一直活着** ⇒ 两个哨兵并行（都去打 /compact，抢同一个会话）。
    //   根因就是我前面几次 `--干跑` 也执行了 beat()：干跑进程写了心跳（pid=自己），
    //   干跑退出后心跳还新、pid 却没了 ⇒ 守护判定"哨兵死了"⇒ 重复拉起。
    //   ⇒ 干跑**不写任何持久状态**（心跳也是状态），只打印。
    if (DRYRUN) return;
    try { fs.writeFileSync(HEARTBEAT_FILE, process.pid + '|' + Date.now()); } catch { /* 写不进不挡主流程 */ }
    // ★★ 2026-11-02 23:58 加：**反向看护守护进程**（双向互保）
    //   宿主：「哨兵禁止崩溃；巡逻的怎么能崩溃呢？」
    //   有了守护（哨兵守护.mjs）能拉起哨兵，但守护自己死了就没人管它。
    //   ⇒ 哨兵每 60 秒顺手体检一次守护：心跳超 180s ⇒ 把守护拉起来。
    //     这样两个进程互为看护，**任何一方单独死掉都会被另一方救活**。
    //     ⚠ 只拉一次、且带 5 分钟冷却，避免互相疯狂启动烧 CPU。
    try { watchGuardian(); } catch { /* 看护失败不影响巡逻 */ }
  };
  beat();
  const beatTimer = setInterval(beat, 60 * 1000);
  if (beatTimer.unref) beatTimer.unref();

  const tick = async () => {
    round++;
    // 心跳已由独立定时器维护，这里不再写（写了也不会更准，只会掩盖 tick 卡死）
    let rows;
    // ★ 每轮重取 cookie（工作台重启后 token 会变，老 cookie 立即失效）
    await ensureCookie(true);
    try { rows = await snapshot(COOKIE); } catch { rows = []; }
    if (!rows.length) {
      // ★ 不再静默：分不清"全空闲"和"引擎连不上"就永远发现不了哑掉
      if (round % 5 === 0) console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] ⚠ 拿不到会话列表（引擎重启中 / cookie 失效）—— 本轮跳过，哨兵仍在岗');
      return;
    }

    const now = Date.now();
    // ══════════════════════════════════════════════════════════════════════
    // ★★ 2026-11-02 修（宿主：「哨兵也参与你这个场景，怎么没有进行？」）★★
    //
    //   我原来写 `rows.filter(r => !r.isSelf ...)` —— 把**命令自己**排除在外。
    //   结果：我这个会话 5.32 MB（164%，远超 2.4 MB 换会话线），哨兵**完全不管**。
    //   宿主的意思很明确：**哨兵游走各个场景「包括你」**，命令不是例外。
    //
    //   ⇒ 现在把 isSelf 也算进 live。
    //     但有一个必须区分的点：
    //       · 压缩（/compact）由**哨兵外部进程**执行 ⇒ 对"我自己"完全安全，照压。
    //       · 换会话（交接.mjs）会把"我自己"归档掉 ⇒ 如果我此刻正在跑这一轮，
    //         归档自己会失败或把当前轮截断。所以：**自己的换会话仍然做，但要允许它失败**，
    //         并把失败原因记清楚（脚本里已有 stopActivity 重试，通常能成功）。
    //     实测：命令会话 5.25 MB 那条就是被 rotate 归档掉的（已归档 · 命令 · 2026-11-01）。
    // ══════════════════════════════════════════════════════════════════════
    const live = rows.filter((r) => !r.archived);          // ␡ 不再排除 isSelf
    const running = live.filter((r) => r.running);
    const nArchived = rows.filter((r) => r.archived).length;
    const nSelf = live.filter((r) => r.isSelf).length;

    // 状态迁移记录：谁从空闲变思考了（一个思考周期 = 一次 startedAt）
    const justStopped = [];      // ★ 三期：本轮"由跑转停"的会话（收工那一刻才催回执）
    for (const r of rows) {
      const prev = state[r.sessionId] || {};
      // ★ 2026-11-02：nudgeTier（催促档位）必须随思考周期归零 —— 否则上一轮的
      //   "已催到第3档"会带进下一轮，新的活儿一开始就直接跳到收口，等于劝退。
      // ★ 三期移植·一期：进度基线 `progress` 也必须随思考周期重置 ——
      //   否则新的一轮会拿上一轮的累计量当基线，把"这轮还没动"误判成"上一轮已动"。
      // ★★ 2026-11-03 13:10 宿主：「**空闲十分钟如果超了就压缩**」
      //   ⇒ 判据必须是**"它空闲了多久"**，而不是"我上次提醒过多久"。
      //     所以这里记 `idleSince`（这个会话从哪一刻起不再干活 = running 由 true→false 的时刻）。
      //   ⚠ 第一次见到它时（state 里没有 idleSince）⇒ **记成本轮 now**，即"从现在起算它空闲"。
      //     为什么不默认"早就空闲"：宁可晚 10 分钟压，也不要在它其实刚接活的那一秒去压。
      //   ⚠ 一旦又变成 running ⇒ idleSince 清零（新的一轮，空闲计时重新来）。
      if (r.running) {
        state[r.sessionId] = { ...(state[r.sessionId] || {}), idleSince: 0 };
      } else {
        const since = Number((state[r.sessionId] || {}).idleSince) || 0;
        if (!since) state[r.sessionId] = { ...(state[r.sessionId] || {}), idleSince: now };
      }
      if (r.running && !prev.running) state[r.sessionId] = { ...prev, idleSince: 0, startedAt: now, pushed: false, nudgedAt: 0, nudgeTier: 0, stalledKey: '', progress: r.progress, progressAt: now };
      if (!r.running && prev.running) {
        state[r.sessionId] = { ...prev, running: false, idleSince: now, startedAt: 0, pushed: false, nudgedAt: 0, nudgeTier: 0, stalledKey: '', progress: r.progress, progressAt: now };
        justStopped.push({ r, prevRunning: true });
      }
      state[r.sessionId] = { ...(state[r.sessionId] || {}), running: r.running, pct: r.pct, turns: r.turns };
    }
    writeState(state);

    // ★ 2026-11-07 宿主最新令：换会话先询问、拿到确认才真换（⛔ 不静默强换）
    try { await processHandoverAsks(COOKIE, state, rows, now, DRYRUN); }
    catch (e) { console.log('⚠ 询问换会话本轮异常（不退出）：' + String((e && e.message) || e)); }

    // ★ 2026-11-08 12:51：急停登记的「待压缩询问」在本轮销项，并把未销项点亮 B③ 判据
    const COMPACT_ASK_SIDS = new Set(readCompactAskQueue().filter((x) => x && !x.done).map((x) => String(x.sid || '')));
    try { await processCompactAskQueue(state, rows, now, DRYRUN); }
    catch (e) { console.log('⚠ 压缩询问队列本轮异常（不退出）：' + String((e && e.message) || e)); }

    const idle = live.filter((r) => !r.running);
    const now2 = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
    let spoke = false;          // 本轮有没有真说过话；没说话就只在 30 分钟节点自报一次"我在岗"

    // ══════════════════════════════════════════════════════════════════════
    // A. 只对「正在干活」的推：**催进度（主）→ 疑似卡死（副）**
    //    顺序不能反：先催它快，催过还没动静才怀疑它挂了。
    // ══════════════════════════════════════════════════════════════════════
    for (const r of running) {
      const st = state[r.sessionId] || {};
      const name = r.scene || r.title;

      // ══════════════════════════════════════════════════════════════════
      // A① 收口闸门（2026-11-09 宿主定稿，取代 10/20/30 分三档催办）
      //   先到者触发：① 收工自检全绿且已过最短窗口 ② 跑满 20 分钟硬兜底
      //   命中 ⇒ 以宿主身份投一句「停，给结论」；同一轮只投一次，之后不再推任何东西。
      //   `--用旧催办` 整段回退到旧三档（真机 A/B 用）。
      // ══════════════════════════════════════════════════════════════════
      const cycleStart = r.stepStartAt || st.startedAt || 0;
      const stepSec = cycleStart ? Math.round((now - cycleStart) / 1000) : 0;
      const stepMin = Math.round(stepSec / 60);
      if (USE_OLD_NUDGE) {
        const tier = nudgeTierFor(stepSec, st.nudgeTier, THINK_SEC);
        if (tier > 0) {
          const txt = nudgeText(tier, stepMin);
          const ok = await push(COOKIE, r.sessionId, txt, DRYRUN);
          const tag = tier === 3 ? '进度汇报' : '催促';
          console.log('[' + now2() + '] ⏩ ' + tag + '(' + tier + '档) → ' + name + '  ' + stepMin + ' 分钟  ' + (ok ? '✓ 已推' : '✗ 失败'));
          state[r.sessionId] = { ...st, nudgeTier: tier, nudgedAt: now };
          spoke = true;
        }
      } else {
        // 提前停默认关（实测收工自检恒红，见参数区注释）。开启时仍要过最短窗口：
        // 上一单留下的记忆本来就可能全绿，不设门槛会在刚开工 3 分钟把活掐死。
        const green = ENABLE_EARLY_STOP && stepSec >= STOP_MIN_SEC ? closingGreen(name) : false;
        const d = stopDecision(stepSec, green, Boolean(st.stopSent), STOP_MIN_SEC, STOP_MAX_SEC);
        if (d.due) {
          const txt = stopText(d.reason, Math.round(STOP_MAX_SEC / 60));
          const ok = await push(COOKIE, r.sessionId, txt, DRYRUN);
          console.log('[' + now2() + '] ⏹ 收口令(' + d.reason + ') → ' + name + '  ' + stepMin + ' 分钟  ' + (ok ? '✓ 已推' : '✗ 失败'));
          if (ok) state[r.sessionId] = { ...st, stopSent: true, stopReason: d.reason, stoppedAt: now };
          spoke = true;
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // A② 疑似卡死（**副线**，只在催过之后还不吭声时才报）
      //   它才是"查是不是死机"的那条，但绝不能和催促抢首发 —— 否则 10 分钟
      //   一到两条一起推，人家收到的第一句就是"你是不是挂了"。
      //   ★ 三期移植·一期：判据 = **累计量增量**（steps/toolMs/llmMs 任一涨 ⇒ 有进展）。
      //     ⛔ 不再是 updatedAt —— 实测它 12 分钟不动而 steps 涨了 3，拿它判活必误报。
      //   ⚠ 必须**重新读** state：st 是循环开头拍下的快照，A① 刚把 nudgedAt 写进去，
      //     还用旧快照的话这里永远看不到 nudgedAt ⇒ 这条永远不会触发（实测踩到）。
      //
      //   ★★ 基线必须"钉住"，不能每轮跟着走 ★★
      //     反例（我第一版就写错）：每轮把基线更新成本轮采样 ⇒ 窗口永远只有 1 个轮询间隔
      //     （3 分钟），永远凑不满 STALL_SEC（10 分钟）⇒ 这条**永远不报**。
      //     正解：**有进展才把基线推到本轮**（窗口重新开始）；没进展就原地不动（窗口继续长）。
      // ══════════════════════════════════════════════════════════════════
      const st2 = state[r.sessionId] || {};
      const curProgress = { ...r.progress, at: now };
      const prevProgress = st2.progress && typeof st2.progress === 'object'
        ? { ...st2.progress, at: st2.progressAt || 0 } : null;
      // 与基线比数值（windowSec=0 ⇒ 只比数值，不看间隔）
      const grewThisRound = prevProgress ? hasProgress(prevProgress, curProgress, 0) : true;
      if (shouldReportStall(now, st2.nudgedAt, prevProgress, curProgress, STALL_SEC, st2.stalledKey)) {
        {
          // 「最后事件时间」只做**显示**（⛔ 不参与判活）
          const lastEventTxt = r.updatedAt
            ? new Date(r.updatedAt).toLocaleTimeString('zh-CN')
            : '未知';
          const idleMin = Math.max(1, Math.round((now - (st2.nudgedAt || now)) / 60000));
          const txt = '【哨兵·疑似卡死】催过之后又 ' + idleMin + ' 分钟没有任何实质进展'
            + '（步数 ' + r.progress.steps + ' · 工具 ' + Math.round(r.progress.toolMs / 1000) + 's'
            + ' · 模型 ' + Math.round(r.progress.llmMs / 1000) + 's 三个累计量都没涨；'
            + '最后事件 ' + lastEventTxt + '）。\n'
            + '⚠ 我推给你的消息可能根本没被执行 —— 这说明进程卡住了，不是你在想。\n'
            + '最常见原因：**弹了提权审批没人点**（应写 approval/asked 事件）、或某个工具调用挂住、或 agent 掉了。\n'
            + '处理：① 一句话确认你还活着；② 换个不需要提权的路径重试；③ 都动不了就明说"需要重启/需要人点"，别静默。';
          const ok = await push(COOKIE, r.sessionId, txt, DRYRUN);
          console.log('[' + now2() + '] ⛔ 疑似卡死 → ' + name + '  零进展 ' + idleMin + ' 分钟  ' + (ok ? '✓ 已推' : '✗ 失败'));
          state[r.sessionId] = { ...st2, stalledKey: progressKey(curProgress) };
          spoke = true;
        }
      }
      // 有进展 ⇒ 基线推到本轮（窗口重新计时）；没进展 ⇒ 基线原地不动（窗口继续累积）
      state[r.sessionId] = {
        ...(state[r.sessionId] || {}),
        progress: grewThisRound || !prevProgress ? curProgress : prevProgress,
        progressAt: grewThisRound || !prevProgress ? now : (st2.progressAt || now),
      };
    }

    // ══════════════════════════════════════════════════════════════════════
    // B. 只对「已经停手」的推：换会话 / 收尾
    //    ★ 宿主 2026-11-02 定，**以《巡航模式》那张模板图为准**：
    //      ★ 2026-11-02 定稿：**判据全部按会话文件大小**（宿主：「以你说的为准而不是图片里的上下文70%」）
    //          文件 ≥ 2.4 MB ⇒ 换会话（让新会话不超限）
    //          文件 ≥ 2.0 MB ⇒ 开始写收尾（别贴红线才动）
    //          文件 ≥ 1.5 MB 或 距上次压缩涨 ≥0.5 MB ⇒ 该压缩
    //    ★ 另一条宿主原话：「压缩上下文等别人思考完了再说呀」
    //      引擎压不了运行中的自己 ⇒ 收尾/交接一律等 running=false。
    // ══════════════════════════════════════════════════════════════════════
    // ★★ 2026-11-03 10:55 修「同一轮问两遍 / 压两遍」（干跑实测抓到的真 bug）：
    //   B③（本段）和 D（抢救式压缩）**都在遍历 idle**，各有一套"没回暗号就追问"的逻辑。
    //   于是同一个会话在同一轮里被问两次：
    //     📝 落盘询问(第 1 次) → 工作台改造 …
    //     📝 落盘询问(第 2 次·抢救段) → 工作台改造 …
    //   10:01:11 / 10:01:38 那次**同样原因压了两遍**（白烧两次摘要模型调用）。
    //   ⇒ 正解：本轮已经处理过的会话记进 handled，D 段直接跳过 —— 一句话，不猜。
    const handled = new Set();
    for (const r of idle) {
      const st = state[r.sessionId] || {};
      const name = r.scene || r.title;
      const pct = r.pct;                 // ⚠ 只用于显示，⛔ 不参与判断
      const cost = r.proj;               // ★ 判据：真实成本（pressureTokens）
      // ★ 到压缩线的会话，本段（B①②③/兜底交接）一定会处理它 —— 已问、已拦、已压、或在冷却中。
      //   记进 handled，让 D 段（抢救式压缩）**本轮不再碰它**。不到压缩线的会话不记（D 也不管）。
      if (cost >= COST_COMPACT) handled.add(r.sessionId);

      // ══════════════════════════════════════════════════════════════════
      // ★★ 2026-11-02 关键修复：**交接死循环**（宿主：「交接完还超然后继续执行了
      //     交接，死循环了」）★★
      //
      //   实测事故链（命令会话，两小时内）：
      //     13:44  4.06 MB → fork 出 3.22 MB → 校验判「3.22 ≥ 2.4 早该交接」→ 失败
      //     13:47  3.22 MB → fork 出 3.22 MB → 同上 → 失败
      //     14:14  4.06 MB → fork 出 3.61 MB → ✓ 报成功
      //     14:19  3.61 MB 的新会话 ⇒ **它没有 gatedAt**（新 sessionId ⇒ state 是空的）
      //            ⇒ 下一轮空闲又要交接 ⇒ **无限循环**
      //
      //   两个根因叠在一起：
      //     ① **fork 是复制，不是压缩**：副本天生 ≥ 原会话的一半（实测 3.2~3.6 MB），
      //        而阈值是 2.4 MB ⇒ 副本**一出生就超线**。
      //     ② **冷却记在 sessionId 上，可交接换的就是 sessionId**：
      //        旧会话的 `gatedAt` 随旧会话一起归档，新会话拿到的是干净 state
      //        ⇒ 冷却每次都归零 ⇒ 同一秒内可以无限交接。
      //
      //   ⇒ 正解：**冷却必须记在「面板」上，不能记在「会话」上。**
      //     面板是恒定的（cmd-chat 永远是 cmd-chat），会话是会被换掉的。
      //     换完之后，同一个面板 6 小时内不许再交接 —— 不管新会话多大。
      //     这就是唯一的刹车，简单且不会误伤大会话（大会话 6 小时后照样能换）。
      //
      //   ★ 2026-11-02 二次修正：判据从 MB 换成 tok 之后，这条刹车依然必需 ——
      //     因为 fork 不降 tok（实测前后两代 tok 完全相同），换了照样超线，
      //     没有面板冷却就是**结构性的必然死循环**，跟用什么单位无关。
      // ══════════════════════════════════════════════════════════════════
      const panelKey = 'panel:' + (r.panelId || r.sessionId);
      const panelSt = state[panelKey] || {};
      const sinceHandover = panelSt.lastHandoverAt ? (now - panelSt.lastHandoverAt) : Infinity;
      const panelCooling = sinceHandover < REPEAT_GATE_MS;      // 6 小时面板冷却

      // ══════════════════════════════════════════════════════════════════
      // ★★ 2026-11-03 11:05 宿主重申顺序（原话）：
      //     「**哨兵都是先压缩，交接会话只有压缩不动的时候再交接**」
      //
      //   老判据 `hitGate = overRatio && compactedEver` 是**快照判据**，两个真漏洞：
      //     ① `compactedEver` 只看"历史上压过没有" ⇒ 昨天压过一次，今天涨到 300k 就直接交接，
      //        **根本没给压缩第二次机会**。这与"先压缩"直接冲突。
      //     ② 更要命的是它的位置：hitGate 一旦成立就在 B① 里 `continue`，
      //        而 B① 排在 B②③**前面** ⇒ 达到交接线时，B③ 的 `/compact` **永远走不到**。
      //        宿主说的"先压缩"在这种时序下是**不可能发生**的。
      //
      //   ⇒ 新判据（关系判据，比的是"压之前 vs 压之后"）：
      //     **压缩不动** = 本会话压过 ≥1 次，且最近一次压缩之后**成本又回到了交接线**，
      //                   且那次压缩的实际效果被记录为"降得不够"（`compactIneffective`）。
      //     ⛔ 不用"压过没有"（那是快照）；⛔ 不用"文件 MB"（负相关 -0.380）。
      //     ⛔ 只要还有压缩余地（没压过 / 上次压完确实降了），就先走 B③ 压缩。
      //
      //   ⚠ 另一个必须修的时序问题：B① 排在 B②③ 前面时，"刚过压缩线"的会话会先被交接掉。
      //     ⇒ 顺序改成：**先算 compressDue（该不该压），该压就先压，压不动才轮到交接。**
      //       见下面 `mustCompressFirst`。
      // ══════════════════════════════════════════════════════════════════
      const compactedEver = !!(st.compactAt || st.compactMB);
      // ★ 交给纯函数判（可正反打），不在流程里写死
      const gateVerdict = handoverOrCompress({
        cost, win: r.win, gateRatio: COST_GATE_RATIO,
        compactAt: st.compactAt, compactIneffective: st.compactIneffective,
      });
      // 还有压缩余地 ⇒ 必须先压，不许交接
      const mustCompressFirst = gateVerdict.action === 'compress-first';
      const hitGate = gateVerdict.action === 'handover';
      const gateBlocked = panelCooling;
      // ⛔⛔ 2026-11-03 07:55 修一个**让"先问再压"整条路走不到**的 bug（宿主问：「哨兵怎么没有问你然后压缩上下文」）：
      //   昨天我把 COST_WARN 从 180k 也改成了 240k（= COST_COMPACT），于是这里变成：
      //     hitWind = cost >= 240000 && !hitGate
      //   而 B② 收尾分支**推完就 `continue`** ⇒ 到压缩线时**永远先命中收尾、永远到不了 B③ 的询问**。
      //   实测证据：07:26–07:52 日志里全是
      //     `🚑 抢救式压缩**暂缓**（还没回落盘暗号）` —— 说明它知道该问，但**一条询问都没发出去**；
      //     而 B③ 的 `📝 落盘询问` 一次也没出现过。
      //   ⇒ 正解：**收尾线必须在压缩线之前**（严格小于），这样 240k 时只命中收尾，
      //     到压缩线后先走 B③ 询问；收尾提醒只是"顺手说一句"，**不能把压缩流程挡掉**。
      //   顺带把 `!hitGate` 保留（兜底交接优先，那个分支自己会 continue）。
      // ★ 2026-11-03 11:05：`mustCompressFirst` 也要排除 —— 一个已到交接线、但**还要先压缩**的会话，
      //   必须一路走到 B③，⛔ 不能被 B② 的收尾提醒（它自带 continue）拦在半路。
      const hitWind = cost >= COST_WARN && cost < COST_COMPACT && !hitGate && !mustCompressFirst;   // ≥ 收尾线且**未到压缩线** ⇒ 只提醒写收尾
      // ══════════════════════════════════════════════════════════════════
      // ══════════════════════════════════════════════════════════════════
      // ★★ 2026-11-03 18:10·**A③ 步数闸 / 输出量闸**（runaway 报警）★★
      //   宿主 17:29 放行「省 token 省时间」；命令实测：**步/轮是耗时的第一解释变量**
      //     （步/轮 4~5 ⇒ 每轮 36~40s；步/轮 33~53 ⇒ 每轮 300~513s，几乎 1:1 线性）。
      //   ⇒ 这个闸的作用是**当场**提示"你跑太多趟了"，别等宿主 8 分钟后自己发现。
      //
      //   ⛔⛔ **只报警、不阻断**：不压缩、不改会话、不派单、不动任何状态机分支。
      //      （催办单原话：「像现有的「收尾线」那样推一条提醒（别自己压缩，别自己派单）」）
      //   ⛔ 判据是**关系**（累计差分还原的「这一轮多了几步」），⛔ 不是"最近 N 步"这种快照 ——
      //      这正是哨兵自己栽过的第 3 次（answeredThisAsk 的 .slice(-8)）。
      //   ⚠ 两条闸（步数 / 输出）**合并成一条提醒**，别推两条骚扰宿主。
      // ══════════════════════════════════════════════════════════════════
      {
        const stG = state[r.sessionId] || {};
        const gv = stepGateVerdict({
          turns: r.turns,
          steps: r.progress.steps,
          decodeTokens: r.progress.decodeTokens,
          prev: stG.stepGate,
          stepLimit: STEP_LIMIT,
          outputLimit: OUTPUT_LIMIT,
          window: STEP_GATE_WINDOW,
        });
        // 快照必须每轮都存（不管有没有报警），否则下一次算不出差分。
        state[r.sessionId] = { ...stG, stepGate: gv.next };
        // 同一段"跑飞"只提醒一次：闸持续命中时，用「命中时的起点」当去重键，
        //   跑飞结束（不再命中）后重新命中才会再推 ⇒ 不刷屏，也不漏掉新一轮跑飞。
        const gateKey = gv.hit ? (stG.stepGateHitKey || (now + '#' + gv.stepsPerTurn)) : '';
        if (gv.hit && stG.stepGateHitKey !== gateKey) {
          const parts = [];
          if (gv.overSteps) parts.push('⚠ 步数超标：**' + gv.stepsPerTurn + ' 步/轮**（上限 ' + STEP_LIMIT + '）—— 跑太多趟了，该并行、该一步到位');
          if (gv.overOutput) parts.push('⚠ 输出过长：**' + gv.decodePerTurn + ' token/轮**（上限 ' + OUTPUT_LIMIT + '）—— 结论该写进文件，回复只留摘要');
          const txt = '【哨兵·跑飞告警】' + parts.join('\n') + '\n'
            + '（实测：步/轮 4~5 ⇒ 每轮 36~40 秒；步/轮 33~53 ⇒ 每轮 300~513 秒）\n'
            + '⛔ 这只是提醒，不压缩、不换会话、不改你的活儿。\n'
            + '（这条不必回复。）';
          const ok = await push(COOKIE, r.sessionId, txt, DRYRUN);
          console.log('[' + now2() + '] 🏃 跑飞告警(' + gv.reasons.join('+') + ') → ' + name
            + '  步/轮 ' + gv.stepsPerTurn + '  输出/轮 ' + gv.decodePerTurn
            + '  样本 ' + gv.samples + '  ' + (ok ? '✓ 已推' : '✗ 失败'));
          state[r.sessionId] = { ...(state[r.sessionId] || {}), stepGateHitKey: gateKey, stepGateWarnedAt: now };
          spoke = true;
        } else if (!gv.hit && stG.stepGateHitKey) {
          // 不再命中 ⇒ 清去重键（下次再跑飞时还能再报）
          state[r.sessionId] = { ...(state[r.sessionId] || {}), stepGateHitKey: '' };
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // B① 换会话（≥2.4 MB）—— 哨兵直接执行，**全程不对话**
      //
      //   宿主 2026-11-02 定的标准流程（照做，别改）：
      //   「哨兵是独立于会话的，他游走在各个场景包括你，超限则压缩很简单的道理；
      //     超过2.4mb就要写好交接换会话；自动执行，不需要对话；
      //     换会话所有场景操作如下，接收指令，立即执行宪法层的那个交接mjs文件，
      //     然后进行交接操作换会话；旧的会话直接归档进入沉淀层」
      //
      //   ⇒ 唯一入口 = `工具\交接.mjs <面板id> --go`
      //     它内部依次做：体检 → 归档副本 + 补 §〇 + 重生成画像
      //                   → `外壳\scripts\换会话.mjs` → `sessions.mjs --rotate`
      //                   → `workspace/archiveSession` **真归档**（旧会话从侧边栏消失，进沉淀层）
      //                   → 新建同名会话顶上 → 写开场消息 → 回写 scenarios json
      //   ⚠ `--force`：允许"§〇 超过 2 小时"也照换（有些会话长期在跑，等不到它自己更新 §〇）；
      //     但 §〇 四小节/三文档/指纹/归档这道闸 **--force 不免**。
      //
      // ★★ 2026-11-03 11:05 宿主重申顺序：「**哨兵都是先压缩，交接会话只有压缩不动的时候再交接**」
      //   ⇒ 这里必须**让路给压缩**：只要这个会话"还有压缩余地"（没压过 / 上次压完确实降了），
      //     本段就**不交接**，直接往下走到 B③ 去压缩。
      //     ⛔ 老的 `hitGate = overRatio && compactedEver` 把"压过"当"压不动"，又因为本段排在
      //        B③ 前面且会 continue ⇒ 到线的会话被直接交接，/compact 永远轮不到 ⇒
      //        宿主嘴里的"先压缩"在代码里**根本不可能发生**。这是时序 bug，不是阈值问题。
      //   ⚠ 让路只是"不交接"，不是"什么都不做"—— 下面 continue 到 B②/B③ 照常判断。
      // ══════════════════════════════════════════════════════════════════
      if (mustCompressFirst) {
        // 到交接线了，但压缩还有余地 ⇒ 明确记一笔"让路给压缩"，然后跳下去走 B③。
        // ⚠ 只在真到交接线时才打，避免刷屏；同一会话 30 分钟一条。
        if (!st.gateDeferredAt || (now - st.gateDeferredAt) > 30 * 60 * 1000) {
          console.log('[' + now2() + '] ⤵ 到交接线但**先压缩**（宿主：先压缩，压不动才交接）→ ' + name
            + '  ' + Math.round(cost / 1000) + 'k (' + Math.round(cost / r.win * 100) + '% 窗口)'
            + '  ' + (compactedEver ? '上次压缩有效，再压一次' : '这个会话还没压过'));
          state[r.sessionId] = { ...st, gateDeferredAt: now };
          spoke = true;
        }
        // ⛔ 不 continue 到遗忘：直接落到下面的 B②/B③ 分支。
        //    但因为已是交接线（≥ 压缩线），B② 的 `cost < COST_COMPACT` 不成立、B③ 成立 ⇒ 会去压。
      } else if (hitGate) {
        // ══════════════════════════════════════════════════════════════
        // ★ 死循环刹车（2026-11-02 宿主报「交接完还超然后继续执行了交接，死循环了」）
        //   ① 交接也治不了（副本天生就 ≥ 阈值）⇒ 不交接，只记一笔
        //   ② 24 小时内已交 3 次 ⇒ 停手报警，等人来看
        //   这两条必须先于任何冷却判断，否则循环还会继续。
        // ══════════════════════════════════════════════════════════════
        if (gateBlocked) {
          const mins = Math.round(sinceHandover / 60000);
          if (!st.loopWarnAt || (now - st.loopWarnAt) > 6 * 3600 * 1000) {
            console.log('[' + now2() + '] ⛔ 交接已阻断（面板冷静期）→ ' + name + '  ' + Math.round(cost / 1000) + 'k tok'
              + '\n    这个面板 ' + mins + ' 分钟前刚交接完，6 小时内不再换。'
              + '\n    原因：fork 是纯复制，实测前后两代 tok 完全相同 ⇒ 再换也不会变小，只会无限循环。'
              + '\n    ⇒ 真正降成本只靠压缩（/compact）；6 小时后仍超再考虑换人。');
            state[r.sessionId] = { ...st, loopWarnAt: now };
            spoke = true;
          }
          continue;
        }

        // ★ 2026-11-02 修（宿主：「怎么还没交接呢？都5分钟了」·事故复盘）：
        //   11:30:17 哨兵执行交接，sessions.mjs 抛 ReferenceError 崩了，一行都没动。
        //   代码里却在**失败之后照样写 `gatedAt = now`** ⇒ 一次"什么都没干的失败"
        //   换来 6 小时冷却，命令会话被锁到 17:30，宿主干等 5 分钟也没有第二次尝试。
        //   这是最坏的组合：出错的代价比成功还高。
        //   ⇒ 现在只有**真成功**才写 gatedAt（6h）；失败写 gateFailAt，10 分钟后重试。
        // ★★ 2026-11-07 宿主最新令：⛔ 不静默强换。先登记到「待询问队列」，
        //    由 processHandoverAsks 发询问 → 等【确认换会话】→ 才跑 交接.mjs --panel <panel> --go --force。
        if (DRYRUN) {
          console.log('[' + now2() + '] ★ [干跑] 该换会话 → 登记待询问队列（面板=' + (r.panelId || '(未知)') + '）→ 询问 → 等确认 → 交接 --go --force → ' + name);
        } else if (!(r.panelId || '')) {
          console.log('[' + now2() + '] ★ 该换会话但认不上面板 id（' + name + '）⇒ 跳过，不硬来');
        } else {
          queueHandoverAsk(r);
        }
        spoke = true;
        continue;
      }

      // B② 收尾线（≥ 收尾 tok）：**现在就开始写收尾**，不是"再等等"
      //   ⚠ 只是让 §〇 变新鲜，⛔ 不是换人 —— 换人不降成本，收尾只是把记忆落盘。
      // ★★ 2026-11-03 13:10 宿主：「不用加 cd 什么 6 小时 12 小时」
      //   ⇒ 原来的 12h 冷却删掉。新判据=**同一个空闲周期只提醒一次**：
      //     拿 `warnedIdleSince` 记住"这次提醒对应的是哪一段空闲（idleSince）"，
      //     它一旦又干活、再空闲，idleSince 变了 ⇒ 自然允许再提醒一次。
      //     ⛔ 不用时钟：时钟会把"已经空闲 3 小时、一直没过线"的会话挡在门外。
      if (hitWind) {
        const idleSince = Number(st.idleSince) || 0;
        if (!st.warnedIdleSince || st.warnedIdleSince !== idleSince) {
          const txt = '【哨兵·开始写收尾】真实成本 ' + Math.round(cost / 1000) + 'k tok（' + Math.round(cost / r.win * 100) + '% 窗口），已到收尾线 '
            + Math.round(COST_WARN / 1000) + 'k。\n'
            + '**别贴顶再动** —— 现在就把这一轮收干净：\n'
            + '① 手头这轮做完就停，别再开新的大活\n'
            + '② 把进度 / 下一步 / 卡点写进场景私有记忆 §〇\n'
            + '③ 有未完成的，写清楚差什么\n'
            + '注：**这不是让你换会话**。该压缩的哨兵会自己压（/compact 才真降成本）；\n'
            + '    只有你**自己觉得想不清了**，才跑 申请交接。\n'
            + '（这条不必回复。）';
          const ok = await push(COOKIE, r.sessionId, txt, DRYRUN);
          console.log('[' + now2() + '] ⚠ 开始写收尾 → ' + name + '  ' + Math.round(cost / 1000) + 'k tok  ' + (ok ? '✓ 已推' : '✗ 失败'));
          state[r.sessionId] = { ...st, warnedAt: now, warnedIdleSince: idleSince };
          spoke = true;
        }
        continue;
      }

      // ══════════════════════════════════════════════════════════════════════
      // ★★ 2026-11-03 13:10 宿主定稿（推翻上面的 6h/12h 冷却）：
      //   原话：「**不用加 cd 什么 6 小时 12 小时，空闲十分钟如果超了就压缩**」
      //   ⇒ 入口判据只剩两条，都是**关系**、都不是时钟：
      //     ① `idleFor >= 10 分钟`   —— 它**真的空闲了**这么久（等人家思考完，宪法 §4.7 第 6 条）
      //     ② `cost >= 压缩线`       —— 现在就过线了（在外层 if 里）
      //   两条同时成立 ⇒ 立刻 [询问 → 验证闸 → /compact]。
      //   ⛔ 不再看 `compactAt`（上次压过多久）—— 那是快照判据，会把"1 小时前压过"当成"现在不许压"，
      //      正好造成过宿主反复问的"到线了却什么都不做"。
      //   ⛔ 也不再要 `grew`（涨够 40% 才压）—— 同上，是快照。
      //
      //   ⚠ 那靠什么防"压完再压"？靠**事实**，不靠时钟：
      //     压缩成功 = tok 真的降了（< 98%）⇒ 成本掉到压缩线以下 ⇒ 外层 `if (cost >= COST_COMPACT)` 不成立
      //     ⇒ 同一会话自然不会再被压。这比冷却更硬：冷却只是"等一会儿还会再压"，而它直接让条件消失。
      //   ⚠ 唯一保留的短重试：**压失败**（命令报错 / 两次采样 tok 都没降）后 10 分钟内不重试，
      //     免得对着一个压不动的会话每 3 分钟锤一次；10 分钟后照常重试，连续 3 次失败会写进 `_待办.md`。
      //     这是"失败重试退避"，不是"成功后的冷却"，两者别混。
      // ══════════════════════════════════════════════════════════════════════
      // ★ 2026-11-08 12:51：急停已用 余量.mjs 当场实测 ≥100% 并登记 ⇒ 点亮 B③（仍只走这一条询问/压缩入口）
      const effCost = COMPACT_ASK_SIDS.has(r.sessionId) ? Math.max(cost, COST_COMPACT) : cost;
      if (effCost >= COST_COMPACT) {
        const idleSince = Number(st.idleSince) || 0;
        const idleFor = idleSince ? (now - idleSince) : 0;
        // ★ 判据全部交给纯函数 compressDue（可正反打）—— 流程里不再写任何阈值比较
        //   ★ 2026-11-03 13:2x 宿主：「超了就询问，然后**等回复后压缩**」
        //     ⇒ 已经回过暗号（ANSWERED）时把 answered=true 传进去，compressDue 会跳过"空闲 10 分钟"那条。
        //       理由：10 分钟门槛是为了"别在人家干活时开口问"；它回完话就是**已经不干了**，
        //       再让它等 10 分钟 = 每次压缩白等一轮（实测就卡在这里）。
        const preAnswered = answeredThisAsk(r, st);
        const due = compressDue({
          cost: effCost, idleForMs: idleFor, compactLine: COST_COMPACT,
          failAt: st.compactFailAt, now, answered: preAnswered,
        });
        // ⚠ 原来这里有个 `overHandoverLine`（到交接线就无视 6h 冷却）—— 冷却已经整体删掉，
        //   这个变量随之作废。⛔ 留着不用会让人以为还有两条入口，删干净。
        if (due.action === 'wait-idle' || due.action === 'retry-later') {
          // 还不能压 ⇒ 只排队，不打扰（这条日志 30 分钟一条，不刷屏）
          if (!st.queuedAt || (now - st.queuedAt) > QUEUE_LOG_MS) {
            console.log('[' + now2() + '] ⏳ ' + due.why + ' → ' + name + '  ' + Math.round(cost / 1000) + 'k');
            state[r.sessionId] = { ...st, queuedAt: now };
            spoke = true;
          }
        } else if (due.action === 'compact') {
          // ★★★ 2026-11-04 23:12 · 老 state 自愈：基线可能被重问污染 => 重开周期 ★★★
          //   现场：程序开发 session-366c2d9d 就是这种 state（askedN=2、无 askCycleAt、
          //         基线 maxMtime 被 22:56:50 那次重问拍成了 22:46:48）=> 闸永久 false。
          //   ⛔ 不猜 cycleAt（猜 = 假绿）；作废这一轮、下一轮重新问一次，从此正确。
          if (legacyAskNeedsReset(st)) {
            console.log('[' + now2() + '] 🔧 老 state 基线可能被重问污染（askedN=' + st.askedN
              + ' · 无 askCycleAt）=> 作废本轮、重开一个干净周期 -> ' + name
              + '  ' + Math.round(cost / 1000) + 'k');
            state[r.sessionId] = {
              ...st, ...askResetPatch(),
            };
            spoke = true;
            continue;
          }
          const askAt = Number(st.askAt) || 0;
          const askedN = Number(st.askedN) || 0;
          // ══════════════════════════════════════════════════════════════════════
          // ★★★ 2026-11-03 16:45 · 第 ① 条硬条件：**本轮真问过，才认暗号** ★★★
          // ══════════════════════════════════════════════════════════════════════
          //   宿主原话（16:29）：「怎么哨兵没问你是否还有有用的记忆存储就自动压缩去了？」
          //   事故现场：`session-3e4474d0` 压缩后 state 里 `askAt=0 / askedN=0`（**本轮没问过**），
          //   但 `askSeq=4044`（07:55 那次）**没被清** ⇒ 只看 askSeq 的 `answeredThisAsk`
          //   把 8 小时前第 21 轮的【已落盘】当成本次的回答 ⇒ 跳过「第 1 段 询问」
          //   ⇒ 直接进「第 1.5 段 验证闸」⇒ 闸过（16:27 刚写过项目信息）⇒ /compact。
          //
          //   ⇒ 这条**写死在流程里**，不依赖 `answeredThisAsk` 内部逻辑：
          //      `askAt > 0 && askedN > 0` 才算"这次问过"；否则一律当"没回" ⇒ 回去问。
          //   ⇒ 双保险：函数内部（answeredThisAsk）也查 askAt；这里再查一次。
          //      将来谁把函数改回去，这一行仍然拦得住。
          const askedThisRound = (askAt > 0 && askedN > 0);
          // ⛔ 没见过暗号 = 没回；**没问过 = 更不能算回了**（没问就回，不是回答我）
          const ANSWERED = askedThisRound ? preAnswered : '';
          const canAskAgain = !askAt || (now - askAt) > ASK_RETRY_MS;

          // ── 第 1 段：还没拿到回话 ⇒ 问它，**不压** ──
          if (!ANSWERED) {
            if (askedN < ASK_MAX && canAskAgain) {
              const n = askedN + 1;
              const txt = '【哨兵·压缩前落盘 · 第 ' + n + ' 次询问】\n'
                + '你的上下文已到压缩线（' + Math.round(cost / 1000) + 'k / ' + Math.round(r.win / 1000) + 'k = '
                + Math.round(cost / r.win * 100) + '%）。压缩不可逆，所以**先确认有没有要留的**：\n'
                + '① **有** ⇒ 写进 `D:\\Lintax数据\\项目\\' + (r.scene || '<场景>') + '\\项目信息\\NN_主题.md`，'
                + '并在 `索引.md` 加一行（`| # | 文档 | 一句话 | 关键词 |`），然后回一句 **【已落盘】**\n'
                + '② **没有** ⇒ 直接回一句 **【无需落盘】**\n'
                + '⚠ 回【已落盘】会被**验证闸**核一遍：项目信息里必须真有文档在本次回答后新增/变过，'
                + '且 `node 工具\\项目本地化体检.mjs` 对你这场景 0 违规。核不过 ⇒ 我不压，会告诉你差什么。\n'
                + '⚠ 只回暗号那一行就够，不要长篇解释 —— 我还要靠这句话决定什么时候压。\n'
                + '⛔ 不回 = 我不压（上下文继续涨到你 413 为止，那时只能换会话）。';
              const ok = await push(COOKIE, r.sessionId, txt, DRYRUN);
              console.log('[' + now2() + '] 📝 落盘询问(第 ' + n + ' 次) → ' + name + '  '
                + Math.round(cost / 1000) + 'k (' + Math.round(cost / r.win * 100) + '%)  '
                + (ok ? '✓ 已推，等它回【已落盘】/【无需落盘】' : '✗ 推送失败'));
              // ★ 记下"问的这一刻"的项目信息快照 + 会话位置（askSeq）——
              //   后面用它比两件事：① 回答之后项目信息有没有真变 ② 暗号是不是**这次问之后**回的
              const askTurn = lastOutlineTurn(r);
              // ★★ askTagFrom（2026-11-03 16:45 · 派单第 ③ 条）：提问那一刻 outline 里**已有的**暗号状态。
              //   后面判定时用它防"旧暗号复用"：回答里的暗号和它一模一样 ⇒ 不算新出现 ⇒ 判没回。
              const tagFrom = tagStateAt(r && r.outline, askTurn.seq);
              state[r.sessionId] = {
                ...st, askAt: now, askedN: n,
                // ★ 2026-11-04 23:05：重问**不重拍**基线（第三个死锁）
                askDocs: askDocsBase(st, askedN, topicSnap(r.scene)),
                askCycleAt: askCycleBase(st, now),
                askSeq: askTurn.seq,
                // ★ 2026-11-04 22:18 修死锁：基线必须是「询问之前那一轮」的 response，
                //   ⛔ 不能用 askTurn.response —— steer 下询问轮回答后会被覆盖成回答内容，
                //   那样 answeredThisAsk 就永远判"没回"（工作台改造 22:07 实测卡死）。
                askResp: respBeforeAsk(r && r.outline, askTurn.seq),
                askTagFrom: tagFrom,
                // ★ 同一次记录里存"提问前最后一个暗号的轮次"——判定时比**轮次**不比字面
                askTagSeq: tagSeqAt(r && r.outline, askTurn.seq),
              };
              spoke = true;
            } else if (askedN >= ASK_MAX && (!st.stuckReportedAt || (now - st.stuckReportedAt) > 6 * 3600 * 1000)) {
              // 问了 3 次还没回 ⇒ 上报，但**仍然不压**
              console.log('[' + now2() + '] ⚠ 问了 ' + askedN + ' 次仍没回话，**不压**（压缩不可逆）→ ' + name
                + '  ' + Math.round(cost / 1000) + 'k (' + Math.round(cost / r.win * 100) + '%)');
              state[r.sessionId] = { ...st, stuckReportedAt: now };
              spoke = true;
            }
            continue;    // ★ 关键：没回话，绝不往下走。下面就是 /compact。
          }

          // ── 第 1.5 段：它回了暗号 ⇒ 先过**验证闸**，过了才允许压 ──
          //   宿主 2026-11-03 10:12：「先询问有没有要保留的项目信息主题，需要过一遍验证闸，
          //   然后保存了有用信息后直接大刀阔斧压缩」
          //   ⛔ 闸不过就不压，并且**当场告诉它差什么**（不然它会以为"回了暗号就完事"，我这边静默不动）。
          const gate = await answerGateCheck(r, st);
          if (!gate.allow) {
            const canTell = !st.gateBlockedAt || (now - st.gateBlockedAt) > ASK_RETRY_MS;
            if (canTell) {
              const txt = '【哨兵·压缩暂缓 · 验证闸没过】\n'
                + '你回的是 ' + (gate.tag || '（没认出暗号）') + '，但闸没放行：**' + gate.why + '**\n'
                + '现在项目信息里的主题文档：' + (gate.nowDocs.count ? gate.nowDocs.names.join('、') : '（一篇都没有）') + '\n'
                + '要过闸，二选一：\n'
                + '① 真写一篇：`D:\\Lintax数据\\项目\\' + (r.scene || '<场景>') + '\\项目信息\\NN_主题.md`，'
                + '并在 `索引.md` 加一行；然后 `node 工具\\项目本地化体检.mjs` 必须对你这个场景 0 违规，再回 **【已落盘】**\n'
                + '② 确实没东西可留：直接回 **【无需落盘】**\n'
                + '⛔ 闸不过我不压。';
              const ok2 = await push(COOKIE, r.sessionId, txt, DRYRUN);
              console.log('[' + now2() + '] 🚧 压缩被验证闸拦下 → ' + name + '  ' + gate.why
                + '  ' + (ok2 ? '✓ 已告知它差什么' : '✗ 告知失败'));
              state[r.sessionId] = { ...st, gateBlockedAt: now, gateBlockedWhy: gate.why };
              spoke = true;
            }
            continue;
          }

          // ── 第 2 段：它已经交代过、且过了闸 ⇒ 现在才压 ──
          const before = cost;
          let res = { ok: false, why: '未执行' };
          if (DRYRUN) {
            res = { ok: true, why: '[干跑] 它已回话，将执行 /compact' };
          } else {
            try {
              // ⛔⛔ 2026-11-02 15:51 修了一个**一直存在、让自动压缩从未成功过**的 TDZ bug：
              //   原来写 `const r = await rpc(..., { agentId: r.sessionId, ... })`
              //   —— 在声明 `r` 的那一行里引用 `r` ⇒ `Cannot access 'r' before initialization`
              //   ⇒ 每轮自动压缩都抛这里，压了 0 个会话。
              //   日志证据：`⤵ 自动压缩 → 视频工作流 126k → 126k tok ✗ Cannot access 'r' before initialization`
              //   这才是"会话越积越满"的真正根因 —— 不是判据不对，是动作压根没执行。
              const rs = await rpc(COOKIE, 'commands/execute', { agentId: r.sessionId, line: '/compact', submittedAttachments: [] });
              // ★★ 2026-11-03 10:30 修「把 RPC ok 当压缩 ok」：
              //   commands/execute 的 result.ok 只代表"命令被受理"，真正的结局在
              //   `result.value.result.kind`（'success' / 'error'）里 —— /compact 忙时会返回
              //   kind:'error' + "Compaction is unavailable because … the agent is not idle."，
              //   老代码照样算 ok=true，于是日志里全是"命令成功但 tok 没降"这种**误导性**结论。
              const inner = (rs && rs.result && rs.result.ok && rs.result.value && rs.result.value.result) || null;
              const kind = inner && inner.kind;
              const text = inner && inner.text;
              if (kind === 'success') res = { ok: true, why: String(text || '已执行 /compact').slice(0, 160) };
              else if (kind === 'error') res = { ok: false, kind: 'error', why: String(text || '命令返回 error').slice(0, 200) };
              else res = { ok: false, why: '命令响应里没有 result.kind：' + JSON.stringify((rs && (rs.result || rs.error)) || rs).slice(0, 160) };
            } catch (e) {
              res = { ok: false, why: String((e && e.message) || e) };
            }
          }
          // 等它压完，再看真实成本降到多少（压缩是真降本，tok 会掉）
          let after = before;
          if (res.ok && !DRYRUN) {
            for (let w = 0; w < 20; w++) {
              await new Promise((z) => setTimeout(z, 1500));
              const rows2 = await snapshot(COOKIE).catch(() => []);
              const cur = rows2.find((x) => x.sessionId === r.sessionId);
              if (cur && typeof cur.proj === 'number') after = cur.proj;
              if (!cur || !cur.running) break;
            }
          }
          // ★ 判"压缩成功"的标准不是"命令返回 ok"，而是**tok 真的降了**。
          //   理由：本轮 TDZ bug 时命令根本没发出去，但更隐蔽的情况是命令 200 了却什么都没做
          //   （会话不空闲 / 引擎拒绝 / 已经是压缩态）。**只有数字变了才算成功。**
          const dropped = res.ok && after < before * 0.98;      // 至少降 2% 才算真生效
          // ★★ 2026-11-03 10:30 修「量早了」造成的**假红**：
          //   实测本会话 10:01:11 发 /compact → 10:01:37 compaction/summary + user/message + compaction/end
          //   = **26 秒才结算**；而老的采样循环里有 `if (!cur || !cur.running) break;`
          //   ⇒ 会话一空闲就立刻跳出 ⇒ 读到压缩前的 266k ⇒ 报「命令成功但 tok 没降」。
          //   真相是压成了（事后 22% / 65k）。⇒ 现在：没降就**多等一轮**再量，仍然没降才算失败；
          //   而且报错措辞要区分"命令报错"和"量到的数没降"（两者根因完全不同）。
          let after2 = after;
          if (res.ok && !dropped && !DRYRUN) {
            for (let w = 0; w < 12; w++) {
              await new Promise((z) => setTimeout(z, 2000));
              const rows3 = await snapshot(COOKIE).catch(() => []);
              const cur3 = rows3.find((x) => x.sessionId === r.sessionId);
              if (cur3 && typeof cur3.proj === 'number') after2 = cur3.proj;
              if (after2 < before * 0.98) break;
            }
          }
          const dropped2 = res.ok && after2 < before * 0.98;
          console.log('[' + now2() + '] ⤵ 自动压缩 → ' + name + '  '
            + Math.round(before / 1000) + 'k → ' + Math.round(after2 / 1000) + 'k tok  '
            + (dropped2 ? '✓ ' + res.why
              : '✗ ' + (res.ok
                ? ('命令返回成功（' + res.why + '）但两次采样 tok 都没降')
                : res.why)));
          // ★ 失败计数：连续 3 次失败会升级成显眼报警（写 _待办.md）
          recordAction(state, '自动压缩', dropped2, dropped2 ? '' : (res.ok ? '命令成功但两次采样 tok 未降' : res.why));
          // ★ 压完清掉询问计数（askAt/askedN），否则下一轮复压时会以为"还没问过"
          // ★★ 2026-11-03 10:50 修「一次到线压两遍」：
          //   实测 10:01:11 压了一次（compactionId 99a3a44e…），10:01:38 又压一次（258ac7b2…）——
          //   两个并行通道各压一次，白烧一次摘要模型调用。
          //   ⇒ 根治方式不是加冷却，是**把第二条通道整段删掉**（见下面 D 段的删除说明，10:55）。
          //     冷却只是当时的第一道补丁，留着不碍事：它防的是"同一会话短时间内反复压"。
          //
          // ★★ 2026-11-03 11:05：把"这次压缩到底管不管用"记成**事实**，
          //   交给 B① 的交接判据用（宿主：「交接会话只有压缩不动的时候再交接」）。
          //   ⛔ 不记"压过没有"——那是快照，会让"昨天压过一次"变成今天的交接理由。
          //   ✅ 记 `compactIneffective`：这次压完 tok 没降（或降幅 < 2%）⇒ 下次越线才允许交接。
          //      压得动 ⇒ 清掉这个标记，下次仍然先压。
          // ★★ 2026-11-03 13:10：压完要记的**只有事实**，不记时钟：
          //   · 压成功（tok 真降了）⇒ 成本已掉到线以下 ⇒ 下一个 `if (cost >= COST_COMPACT)` 自然不成立。
          //     `compactAt` 留着**只为显示/复盘**，⛔ 不再参与入口判据（冷却已删）。
          //   · 压失败（命令报错 / 两次采样都没降）⇒ 记 `compactFailAt` + `compactIneffective`，
          //     10 分钟后重试（失败退避，不是 6h 冷却）；连续 3 次失败写进 `_待办.md` 报警。
          state[r.sessionId] = {
            ...st, compactAt: now, compactCost: after2, rescuedAt: now,
            compactIneffective: !dropped2,        // ★ 压缩治不了 = 真事实，不是"曾经压过"
            compactFailAt: dropped2 ? 0 : now,    // ★ 只给"失败重试退避"用；成功就清零
            // ★★★ 2026-11-03 16:45 补清 askSeq / askResp（本次事故的第 2 个根因）★★★
            //   原来只清了 askAt/askedN ⇒ **askSeq/askResp 留在 state 里**。
            //   实测：16:29 压缩完，`session-3e4474d0` 的 state 里还留着
            //   `askSeq=4044`（07:55 那次询问的锚点）+ `askResp="收尾已完成。…"`。
            //   下一次到线时 `answeredThisAsk` 只看 askSeq ⇒ 8 小时前的旧暗号被当成本次的回答
            //   ⇒ 跳过询问 ⇒ 直接过闸压。**留下的那半是会咬人的那半。**
            //   ⇒ 压缩 = 这一轮的提问-回答周期**整个结束** ⇒ 锚点必须一并清掉。
            ...askResetPatch(),
            stuckReportedAt: 0, gateBlockedAt: 0, queuedAt: 0,
          };
          spoke = true;
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // C. 在干活但已过线的 ⇒ 只记一笔"待它停手再提醒"，**绝不打断**
    //    日志里能看到排队，等它 running=false 那一轮 B 段自然会推。
    //    ★ 2026-11-03 13:10：这只是**日志去重**（30 分钟一条），⛔ 不参与任何判据。
    // ══════════════════════════════════════════════════════════════════════
    for (const r of running) {
      const st = state[r.sessionId] || {};
      const overLine = r.proj >= COST_COMPACT;
      if (!overLine) continue;
      if (!st.deferredAt || (now - st.deferredAt) > QUEUE_LOG_MS) {
        console.log('[' + now2() + '] ⏸ 排队（等它停手再压，不打断）：' + (r.scene || r.title)
          + '  ' + Math.round(r.proj / 1000) + 'k tok' + (r.win ? '（' + Math.round(r.proj / r.win * 100) + '% 窗口）' : ''));
        state[r.sessionId] = { ...st, deferredAt: now };
        spoke = true;
      }
    }

    // 「我在岗」自报：30 分钟一次，且本轮没别的可说才写 —— 不再每轮刷屏
    if (!spoke && (now - lastTellAt) > HEARTBEAT_LOG_MS) {
      console.log('[' + now2() + '] · 在岗：' + running.length + ' 个在干活 / ' + idle.length + ' 个空闲'
        + (nArchived ? ' / ' + nArchived + ' 个归档（不推）' : '') + '，没有要提醒的');
      lastTellAt = now;
    }
    writeState(state);

    // ══════════════════════════════════════════════════════════════════════
    // D. 【已删除】抢救式压缩 —— 2026-11-03 10:55
    //
    //   它原来声称治「会话永远 running ⇒ 等不到空闲 ⇒ 压不到」。
    //   ⛔ 但它的循环写的是 `for (const r of idle)` —— **永远 running 的会话根本不在 idle 里**，
    //      所以它从来治不了自己声称要治的病；它实际做的，只是把 B③ 的活**再做一遍**。
    //
    //   实测代价（不是我推测，是日志/会话日志里的原文）：
    //     · 同一轮同一会话被问两次：📝 落盘询问(第 1 次) / 📝 落盘询问(第 2 次·抢救段)
    //     · 10:01:11 与 10:01:38 压了两遍：compactionId 99a3a44e…（cmd-…-8）/ 258ac7b2…（cmd-…-9）
    //       ⇒ 白烧两次摘要模型调用，而且第二次压的是**已经被压过的**历史。
    //
    //   ⇒ 结论：**压缩只留一条路 = B③**。这里不再有第二条通道。
    //      想改压缩行为，改 B③；⛔ 不许在这个文件里再出现第二处压缩执行点。
    //      `--自测` 里有一条静态断言守着"执行点个数 = 1"，加错了会当场报红。
    // ══════════════════════════════════════════════════════════════════════
    writeState(state);

    // ══════════════════════════════════════════════════════════════════════
    // G. ★ 三期·**收工未回执自动催**（宿主 2026-11-02 那条规矩的机器版）
    //
    //   宿主原话：「**各个场景结束后要跟你汇报，然后你总结给我；
    //              我看没有跟你说你也没找我汇报**」
    //
    //   为什么必须有这一段：光写文档证明没用 —— 程序开发 17:55 接单、18:18 干完、
    //   一期 48/48 全绿，**通道上一次回执都没发**。文档里"必须回执"写了三遍照样漏。
    //   ⇒ 只能让机器在"收工这一刻"堵住它：running 一 true→false 就查台账。
    //
    //   ⚠ 判据只在 `shouldAskReceipt / receivableTickets` 里（纯函数、`--自测` 15 条）；
    //     台账数据只从 `查回执台账.mjs --json` 来（回执判据的**唯一真源**，
    //     不在这里再抄一份，否则两份判据迟早跑偏）。
    //   ⚠ 催回执 ≠ 催进度：它只发生在**已经停手之后**，不会打断正在干的活。
    // ══════════════════════════════════════════════════════════════════════
    if (justStopped.length) {
      let bySid = new Map();
      try { bySid = await loadTicketsBySession(); } catch { bySid = new Map(); }
      for (const { r } of justStopped) {
        if (r.archived) continue;                    // 已归档 ⇒ 不推
        if (r.isSelf) continue;                      // ⛔ 命令自己 ⇒ 不推（宿主：哨兵管别人，不催自己）
        const tickets = bySid.get(r.sessionId) || [];
        const st0 = state[r.sessionId] || {};
        // 线程安全的写法：先把"这一轮要催的单"算出来，再逐单记冷却
        const pending = receivableTickets(true, false, tickets, st0, now);
        if (!pending.length) continue;
        const list = pending.map((t) => '· ' + String(t.ts).slice(11) + ' ' + String(t.head || '').slice(0, 40)).join('\n');
        const txt = '【哨兵·收工未回执】你这轮干完了，台账上还有 **' + pending.length + ' 单**没回执：\n'
          + list + '\n'
          + '⇒ 立刻补：`node 工具\\发消息.mjs --to 命令 --回执 "【<你的场景名>】结论：… 证据：… 落盘：… 还差：…"`（末行加【结束】）\n'
          + '说明：**干完了不吭声 = 通道上没交**。宿主看到的就是"活干完了没人报"。\n'
          + '（同一单 30 分钟内只催一次；已回执/已归档的不催。）';
        const ok = await push(COOKIE, r.sessionId, txt, DRYRUN);
        console.log('[' + now2() + '] 📮 收工未回执 ' + pending.length + ' 单 → ' + (r.scene || r.title)
          + '  ' + (ok ? '✓ 已催' : '✗ 失败'));
        const asked = { ...((st0 && st0.receiptAsked) || {}) };
        for (const t of pending) asked[openTicketKey(t)] = now;
        state[r.sessionId] = { ...(state[r.sessionId] || {}), receiptAsked: asked };
        recordAction(state, '收工未回执催办', ok, ok ? '' : 'session/prompt 未被接受');
        spoke = true;
      }
      writeState(state);
    }

    // ══════════════════════════════════════════════════════════════════════
    // E. 自动交接（内挂，取代"计划任务"方案）
    //
    //   ★ 2026-11-02 15:00 为什么内挂而不是注册计划任务：
    //     本进程跑在 **Low 完整性级别**（`Mandatory Label\Low Mandatory Level`），
    //     schtasks 连 /Query 都报 "The system cannot find the path specified"（实测）。
    //     计划任务创建要求 Medium+，我**没有权限**，也不该为了这个去提权。
    //   ⇒ 挂到哨兵里：哨兵本来就是常驻独立进程（工作台活着它就在），
    //     跑的是**同一个用户、同一个 ROOT**，不需要任何额外权限。
    //   ⚙ 频率：每 30 分钟一次（按 INTERVAL 轮次换算，默认 3 分钟/轮 ⇒ 10 轮）。
    //     可 `--自动交接 分` 覆盖；`--无自动交接` 关掉。
    //   ⛔ 它内部有全套安全边界（不打断在跑的、每轮最多 2 个、面板冷却 6h），
    //     而且**只处理"会话自己申请"和"压缩过仍 ≥90% 窗口"两类**，不会乱换人。
    // ══════════════════════════════════════════════════════════════════════
    if (AUTO_HANDOVER && !DRYRUN) {
      const everyRounds = Math.max(1, Math.round(AUTO_HANDOVER * 60 / INTERVAL));
      if (round % everyRounds === 0) {
        const { spawnSync } = await import('node:child_process');
        const t0 = Date.now();
        try {
          const ah = spawnSync(process.execPath, [path.join(ROOT, '工具', '自动交接.mjs'), '--执行', '--quiet'], {
            cwd: ROOT, encoding: 'utf8', timeout: 600000, windowsHide: true,
          });
          const out = String(ah.stdout || '') + String(ah.stderr || '');
          const last = out.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
          // 只在真有动作（成功/失败）时打日志，安静的"没有需要交接的"不刷屏
          if (ah.status !== 0 || /✓ 完成|✗ 未完成|开始交接/.test(out)) {
            console.log('[' + now2() + '] 🔁 自动交接（内挂，每 ' + AUTO_HANDOVER + ' 分钟）exit=' + ah.status
              + '  ' + Math.round((Date.now() - t0) / 1000) + 's\n    ' + last.slice(0, 400));
          }
          // ⚠ "没有需交接的"（exit 0 且无动作）**也算成功** —— 它是正常工作，
          //   不能因为长期没活干就把这个动作判成"一直失败"。
          recordAction(state, '自动交接', ah.status === 0, ah.status === 0 ? '' : (last.slice(0, 200) || ('exit ' + ah.status)));
        } catch (e) {
          console.log('[' + now2() + '] 🔁 自动交接异常：' + String((e && e.message) || e));
          recordAction(state, '自动交接', false, String((e && e.message) || e));
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // F. ★ 每轮收尾：检查有没有"连续失败"的自动动作 ⇒ 升级报警
    //    这是本轮加的护栏本身：光记失败没用，**必须有人看得见**。
    // ══════════════════════════════════════════════════════════════════════
    alertFailing(state, now);
  };

  // ══════════════════════════════════════════════════════════════════════
  // ★★ 2026-11-02 23:47 修：**哨兵被一次网络抖动整死**（实测事故）
  //
  //   事故：23:30:44 还在正常催（程序开发 2 档、本地电脑/工作台改造 1 档），
  //        之后心跳停在 23:30，进程消失。err 文件里是：
  //          TypeError: fetch failed  { cause: Error: read ECONNRESET }
  //          triggerUncaughtException(err, true /* fromPromise */)
  //   ⇒ 根因：`setInterval(tick, ...)` 里 tick 是 async，
  //      **任何一处 await 抛错（这里就是 fetch 被重置）都会变成 unhandled rejection**，
  //      而 Node 24 默认把 unhandled rejection 当致命错 ⇒ **整个哨兵进程退出**。
  //      引擎重启 / 工作台刷新 / 短暂网络抖动都能触发 —— 这不是偶发，是必然。
  //
  //   ⇒ 三层护栏（缺一不可）：
  //     ① **单轮隔离**：tick 用 try/catch 包起来，一轮失败只记一笔，下一轮照常跑。
  //        ⛔ 不许让"这一轮拿不到数据"升级成"哨兵下班"。
  //     ② **兜底捕网**：unhandledRejection / uncaughtException 只记日志不出进程。
  //        （哨兵是常驻守护进程，活着比"崩得干净"重要得多。）
  //     ③ **连续失败升级**：连续 N 轮全挂 ⇒ 记进失败计数（沿用 recordAction 的报警机制），
  //        但**仍然不退出** —— 让人在日志/待办里看见，而不是让哨兵自己消失。
  // ══════════════════════════════════════════════════════════════════════
  let tickFails = 0;
  const safeTick = async () => {
    try {
      await tick();
      if (tickFails) { console.log('[' + ts() + '] ✓ 恢复：连续失败 ' + tickFails + ' 轮后本轮成功'); tickFails = 0; }
    } catch (e) {
      tickFails++;
      const msg = String((e && e.message) || e);
      console.log('[' + ts() + '] ⚠ 本轮失败（第 ' + tickFails + ' 次，**哨兵不退出**）：' + msg);
      recordAction(state, '哨兵轮询', false, msg);
      alertFailing(state, Date.now());
      try { writeState(state); } catch { /* 连状态都写不进，继续跑 */ }
    }
  };

  // 兜底捕网：先把"致命"降级成"记一笔"，再继续。
  process.on('unhandledRejection', (e) => {
    try { console.log('[' + ts() + '] ⚠ 未处理的 Promise 异常（已捕获，哨兵继续）：' + String((e && e.message) || e)); } catch { }
  });
  process.on('uncaughtException', (e) => {
    try { console.log('[' + ts() + '] ⚠ 未捕获异常（已捕获，哨兵继续）：' + String((e && e.message) || e)); } catch { }
  });

  await safeTick();
  const timer = setInterval(safeTick, INTERVAL * 1000);
  process.on('SIGINT', () => { clearInterval(timer); console.log('\n哨兵退出'); process.exit(0); });
  return new Promise(() => { });   // 常驻
}

/**
 * 反向看护：守护进程（`工具\哨兵守护.mjs`）还在吗？不在就拉起来。
 *
 * ★ 为什么哨兵要管守护：单向看护有个死结 —— 守护能救哨兵，但守护自己死了没人救。
 *   两个进程互看，才没有单点。宿主说「巡逻的怎么能崩溃呢」，那就让它自己也有个巡逻的。
 *
 * ⛔ 三条纪律（防止互相疯狂拉起烧 CPU）：
 *   ① 只在**心跳超时**时才动手（不据 mtime 单独判 —— 还要 pid 真不在）
 *   ② 有 **5 分钟冷却**（内存级，进程重启后重置）
 *   ③ 拉起失败**只记日志**，绝不重试成环
 */
let lastGuardSpawnAt = 0;
function watchGuardian() {
  // ★★ 2026-11-03 11:20 修「干跑把真守护拉起来」（本轮实测到的真事故）：
  //   我用 `--干跑 --间隔 60` 做链路验证时，这个进程也会执行 watchGuardian()，
  //   而它的「5 分钟冷却」是内存级的（新进程 = 0）⇒ 一旦判定守护"不在岗"，
  //   就 spawn 了一个**真的** `哨兵守护.mjs --间隔 60`。
  //   实测后果：11:15:21 多出 PID 34024，与在岗的 26512 并列
  //   ⇒ 两个守护同时看护 ⇒ 会各自拉起哨兵抢着压缩同一个会话（正是宿主抱怨的那类乱象）。
  //   ⇒ 干跑**只读不写、只打印不 spawn**，这是 `--干跑` 该有的边界。
  if (DRYRUN) return;
  const GA = path.join(ROOT, '引擎', '.tmp', '哨兵守护.alive');
  let raw = '';
  try { raw = fs.readFileSync(GA, 'utf8'); } catch { /* 守护从没起过 */ }
  const nowMs = Date.now();
  let need = false;
  if (!raw) {
    need = true;                                   // 心跳文件都没有 ⇒ 从没起过/被删
  } else {
    const mp = raw.trim().match(/^(\d+)\|(\d+)$/);
    if (!mp) need = true;
    else {
      const p = Number(mp[1]), at = Number(mp[2]);
      const age = nowMs - at;
      // ★ 2026-11-08：原来这里内联第三份判活（EPERM 即活）；改调共用实现，同一个误判一起治
      const pidOk = pidAlive(p);
      need = age > 180000 || !pidOk;
    }
  }
  if (!need) return;
  if (nowMs - lastGuardSpawnAt < 5 * 60 * 1000) return;   // 冷却中，别疯狂起
  lastGuardSpawnAt = nowMs;
  try {
    spawn(process.execPath, [path.join(ROOT, '工具', '哨兵守护.mjs'), '--盯', '--间隔', '60'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    console.log('[' + ts() + '] 🛡 发现守护不在岗 ⇒ 已拉起');
  } catch (e) {
    console.log('[' + ts() + '] ⚠ 拉起守护失败（只记一次，不重试成环）：' + String((e && e.message) || e));
  }
}

/**
 * ★★ 2026-11-03 11:05：**先压缩，压不动才交接**（宿主原话）。
 *
 * 「交接会话只有压缩不动的时候再交接」—— 这句话里有两个词必须在代码里有对应的事实：
 *   · 「先压缩」  ⇒ 只要还有压缩余地，就不许交接。
 *   · 「压不动」  ⇒ 必须是**量出来的**：上一次压缩实测没把 tok 降下去。
 *                   ⛔ 不是"曾经压过"（那是快照，昨天的压缩管不了今天）。
 *
 * 三种结局：
 *   'none'          没到交接线 ⇒ 什么都不用做
 *   'compress-first' 到交接线，但还有压缩余地 ⇒ **必须先压**，不许交接
 *   'handover'      到交接线，且上次压缩实测无效 ⇒ 才允许交接
 *
 * ⚠ 为什么这条要抽成纯函数：它决定了「压缩 vs 换人」这个最贵的分叉。
 *   实测代价：老判据 `overRatio && compactedEver` + B① 排在 B③ 前面 ⇒
 *   到线的会话被直接交接，`/compact` **永远轮不到** ⇒ 宿主说的"先压缩"根本不可能发生。
 *   这种时序 bug 只有把判据单独拿出来正反打才抓得住。
 * @param {{cost:number, win:number, gateRatio:number, compactAt:number, compactIneffective:boolean}} o
 * @returns {{action:'none'|'compress-first'|'handover', why:string}}
 */
function handoverOrCompress(o) {
  const cost = Number(o && o.cost);
  const win = Number(o && o.win);
  const ratio = Number(o && o.gateRatio);
  // ⚠ NaN 比较恒 false ⇒ 脏数据会被当成"没到线"（安全方向），但仍要显式拒掉：
  //   这里如果 win 是 0/NaN，overLine 判不出来 ⇒ 返回 none，绝不贸然交接。
  if (!Number.isFinite(cost) || !Number.isFinite(win) || !Number.isFinite(ratio) || win <= 0) {
    return { action: 'none', why: '成本/窗口数据不可用，不敢判' };
  }
  if (cost < win * ratio) return { action: 'none', why: '未到交接线' };
  const compressed = !!(o && o.compactAt);
  const ineffective = !!(o && o.compactIneffective);
  if (!compressed) {
    return { action: 'compress-first', why: '已到交接线但**一次都没压过** ⇒ 先压（宿主：先压缩）' };
  }
  if (!ineffective) {
    return { action: 'compress-first', why: '已到交接线，但上次压缩**实测有效** ⇒ 先再压一次' };
  }
  return { action: 'handover', why: '已到交接线，且上次压缩**实测没降下去** ⇒ 压缩治不了，才交接' };
}

/**
 * ★★ 2026-11-03 13:10 宿主定稿：**"现在该不该压"只有一个判据函数**
 *
 * 宿主原话：「**不用加 cd 什么 6 小时 12 小时，空闲十分钟如果超了就压缩**」
 *
 * 判据（两条，都是**关系**，都不是时钟快照）：
 *   ① `idleForMs >= IDLE_BEFORE_COMPACT_MS`（默认 10 分钟）—— 它**真的空闲了**这么久
 *   ② `cost >= compactLine`                                   —— 它**现在**过线了
 * 两条同时成立 ⇒ 压。
 *
 * ★★ 2026-11-03 13:2x 宿主补充：「**超了就询问，然后等回复后压缩**」
 *   ⇒ `answered = true`（它**已经回过**这次询问的暗号）时，**跳过第 ① 条**。
 *   为什么：10 分钟空闲是"别在人家干活时打扰"的门槛，只对**开口问**那一步成立。
 *   会话回话这件事本身就意味着它刚跑完一轮 —— 回完立刻变空闲，`idleSince` 被重置成"此刻"，
 *   如果还要求再等 10 分钟，**每次压缩都要白等一轮**（实测就是这么卡的）。
 *   它已经交代完了、也停手了，就该立刻过闸 → 压。
 *
 * ⛔ 明确**不看**这些东西（都是快照，都会让"到线了却不动"）：
 *   · `compactAt`（上次压过多久）—— 昨天的压缩不该变成今天的禁令
 *   · `grew`（比上次多涨 40% 才压）—— 差值太脆，实测 85k/96k 就差一点 ⇒ 什么都不做
 *
 * ⚠ 防重复压缩靠的是**事实**不是冷却：压缩成功 ⇒ tok 降 ⇒ 判据②自然不成立。
 *   只有**压失败**才退避 `COMPACT_RETRY_MS`（10 分钟），10 分钟后照常重试。
 *
 * @param {{cost:number, idleForMs:number, compactLine:number, failAt?:number, now:number,
 *          retryMs?:number, idleMs?:number, answered?:boolean}} o
 * @returns {{action:'compact'|'wait-idle'|'retry-later'|'none', why:string, idleMin:number}}
 */
function compressDue(o) {
  const cost = Number(o && o.cost);
  const idleForMs = Number(o && o.idleForMs);
  const line = Number(o && o.compactLine);
  const now = Number(o && o.now);
  const failAt = Number(o && o.failAt) || 0;
  const answered = !!(o && o.answered);
  const retryMs = Number.isFinite(Number(o && o.retryMs)) ? Number(o.retryMs) : COMPACT_RETRY_MS;
  const idleMs = Number.isFinite(Number(o && o.idleMs)) ? Number(o.idleMs) : IDLE_BEFORE_COMPACT_MS;
  // 脏数据 ⇒ 不动（安全方向：宁可漏压一次，也不拿脏数据去压别人的会话）
  if (!Number.isFinite(cost) || !Number.isFinite(line) || !Number.isFinite(now) || !Number.isFinite(idleForMs)) {
    return { action: 'none', why: '成本/空闲时长不可用，不敢判', idleMin: 0 };
  }
  const idleMin = Math.floor(Math.max(0, idleForMs) / 60000);
  if (cost < line) return { action: 'none', why: '未到压缩线', idleMin };
  if (!answered && idleForMs < idleMs) {
    return {
      action: 'wait-idle', idleMin,
      why: '已过压缩线，但只空闲了 ' + idleMin + ' 分钟 < ' + Math.round(idleMs / 60000) + ' 分钟',
    };
  }
  if (failAt && (now - failAt) < retryMs) {
    return {
      action: 'retry-later', idleMin,
      why: '上次压缩失败，' + Math.max(1, Math.ceil((retryMs - (now - failAt)) / 60000)) + ' 分钟后重试',
    };
  }
  return {
    action: 'compact', idleMin,
    why: answered
      ? '它已回话（交代完了）⇒ 立刻过闸 → 压（⛔ 不再等 10 分钟）'
      : '空闲 ' + idleMin + ' 分钟且已过压缩线 ⇒ 立刻问 → 过闸 → 压',
  };
}

/**
 * ★ 2026-11-03 10:55：**压缩执行点只许一处**（静态断言用）。
 *
 * 这个文件里曾经有**两条**并行的压缩通道（B③ 自动压缩 / D 抢救式压缩），
 * 而 D 的循环写的是 `for (const r of idle)` —— **永远 running 的会话根本不在 idle 里**，
 * 所以它治不了自己声称要治的病，只是把 B③ 的活再做一遍。
 * 实测代价：同一轮同一会话被问两遍；10:01:11 与 10:01:38 压了两遍
 * （compactionId 99a3a44e… / 258ac7b2…），白烧两次摘要模型调用。
 *
 * ⇒ 判据 = 源码里真正的 `/compact` 执行点必须**恰好 1 个**。
 *   数到 2 ⇒ 有人又开了一条并联通道；数到 0 ⇒ 压缩被删没了。两种都该红。
 * ⛔ 只数**真执行行**：同一行必须同时出现 `commands/execute` 和 `line: '/compact'`。
 *   这样注释、以及自测里那些"假装是调用"的示例字符串都不会被误算
 *   （第一版没做这个区分，结果自测自己把自己数成 3 个 ⇒ 假红）。
 * @param {string} src 源码全文
 * @returns {number}
 */
function countCompactCallSites(src) {
  const lines = String(src || '').split(/\r?\n/);
  let n = 0;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;   // 注释不算
    if (/commands\/execute/.test(l) && /line:\s*'\/compact'/.test(l)) n++;
  }
  return n;
}

/**
 * 这个会话有没有回过「压缩前落盘」的暗号？
 * 判据 = turnOutline 里**会话自己的回复(response)** 出现了【已落盘】/【无需落盘】。
 *
 * ★★ 只认 response，⛔ 绝不认 prompt —— 这是我第一版写错的地方：
 *   哨兵的提问原文里就写着「回一句【已落盘】」，
 *   如果把 prompt 也算命中，**刚问完就立刻判定"已回话"** ⇒ 闸等于没有 ⇒ 照样不问就压。
 *   （这个 bug 是被自测里"暗号在 prompt 里"那条用例打出来的，正反都打才有用。）
 *
 * ★ 为什么从 turnOutline 找：引擎只在 turnOutline 里保留每轮 prompt 全文 + response 摘要，
 *   这是唯一稳定可读的出口；暗号 6 个字，摘要里一定留得住。
 * @param {{ outline?: Array<{turn:number,seq?:number,prompt:string,response?:string}> }} r
 * @param {number} [minSeq] 只认 seq 大于它的轮次（= 提问那一刻之后）
 * @returns {boolean}
 */
function gotAnswer(r, minSeq) {
  return answerTagOf(r, minSeq) !== '';
}

/** turnOutline 里 seq 最大的那一轮（= "我现在说到哪儿了"）。读不到返回 {seq:0, response:''}。 */
function lastOutlineTurn(r) {
  const oc = (r && Array.isArray(r.outline)) ? r.outline : [];
  let best = { seq: 0, response: '' };
  for (const t of oc) {
    const s = Number(t && t.seq) || 0;
    if (s > best.seq) best = { seq: s, response: String((t && t.response) || '') };
  }
  return best;
}
function lastOutlineSeq(r) { return lastOutlineTurn(r).seq; }

/**
 * 会话回的是哪个暗号（只看 response，⛔ 不看 prompt）。
 * 两个都出现时以**后出现的**为准（它可能先写【已落盘】再补一句【无需落盘】）。
 *
 * ★★ 2026-11-03 16:45：把 **minSeq 分支**的条数截断也去掉了。
 *   原来 `min ? ...filter(seq>min).slice(-8) : all.slice(-3)` —— 前半是**按条数**的快照判据，
 *   会犯和 `answeredThisAsk` 一模一样的病（轮次少时旧暗号混进来、轮次多时新暗号掉出去）。
 *   ⇒ 给 minSeq 就**只看 seq > minSeq**（关系判据）。
 *
 *   ⚠ **无 minSeq 分支保留「最近 3 轮」**：那不是快照失误，是通用手册里明文写的规矩
 *     （「只认最近 3 轮，⛔ 翻旧账不算」），而且这条路径（`gotAnswer(r)`）**不在生产链路上**
 *     —— 真正的判定走 `answeredThisAsk`（带 askSeq + askAt 双条件）。
 *     ⇒ 两条分支语义不同，别一起改。
 * @param {number} [minSeq] 给了就只认 seq > minSeq 的轮次（⛔ 不许拿上一次的回答当这一次的）
 * @returns {'【已落盘】'|'【无需落盘】'|''}
 */
function answerTagOf(r, minSeq) {
  const all = (r && Array.isArray(r.outline)) ? r.outline : [];
  const min = Number(minSeq) || 0;
  // ⛔ minSeq 分支不再 .slice(-8)：条数是快照判据（第三次栽在这上面）
  const oc = min ? all.filter((t) => (Number(t && t.seq) || 0) > min) : all.slice(-3);
  let hit = '';
  for (const t of oc) {
    const s = String((t && t.response) || '');
    for (const tag of ANSWER_TAGS) if (s.includes(tag)) hit = tag;
  }
  return hit;
}

/**
 * ★★ 2026-11-03 16:45 · 派单第 ③ 条要求的 `askTagFrom`
 *   —— 「提问那一刻已存在的暗号状态」，用来防**旧暗号复用**。
 *
 *   背景：16:29 那次事故里，8 小时前的【已落盘】被当成本次的回答。
 *   `askSeq`（关系判据）已经能挡住"提问之前"的那条，但还有一个更细的场景：
 *   **同一轮**里，提问前就写好的 response（askResp 已记录）和提问后被补上的内容。
 *   ⇒ 记下"提问那一刻最新一轮的暗号是什么"（`askTagFrom`），
 *      回答里出现的暗号如果**和提问那一刻一样**，就不能算"新出现了暗号"。
 *
 *   ⚠ 这是**关系**（提问前后暗号状态的变化），不是快照（轮次数）。
 *   ⚠ 只有一个暗号时它恒为 ''（没有可区分性）⇒ 这时判据退化成 askSeq 那一道，
 *     这没关系 —— askSeq + askAt 已经够了，这个字段是**加一层保险**，不是唯一一道。
 *
 * @param {Array<{turn:number,seq?:number,prompt:string,response?:string}>} outline
 * @returns {string} 提问那一刻已存在的暗号（'' / '【已落盘】' / '【无需落盘】'）
 */
/**
 * 「提问之前」那一轮的 response —— askResp 的正确基线。
 *
 * ⛔ 为什么不能用 lastOutlineTurn(r)：steer 会把询问插进**当前步骤**，
 *   它回答后这一轮（seq === askSeq）的 response 就被覆盖成回答了。
 *   若把它当基线 ⇒ 回答 === 基线 ⇒ answeredThisAsk 永远判"没回"（死锁，2026-11-04 实测）。
 *
 * ⇒ 只看 **seq < askSeq** 里最靠后的那一轮。取不到返回 ''（= 没有基线，不是"已有暗号"）。
 * @param {Array} outline
 * @param {number} askSeq  询问那一轮的 seq
 * @returns {string}
 */
function respBeforeAsk(outline, askSeq) {
  const oc = Array.isArray(outline) ? outline : [];
  const base = Number(askSeq) || 0;
  if (!base) return '';
  let bestSeq = -1;
  let bestResp = '';
  for (const t of oc) {
    const q = Number(t && t.seq) || 0;
    if (q >= base) continue;              // ⛔ 询问那一轮及之后都不算（这是本次 bug 的根源）
    if (q > bestSeq) { bestSeq = q; bestResp = String((t && t.response) || ''); }
  }
  return bestResp;
}

/**
 * 「提问之前最后一个暗号」所在的轮次 —— askTagSeq 的取值器。
 *   ⛔ 只认 seq < base（严格小于）：询问那一轮在 steer 下会被补进回答，不能算"提问前"。
 *   返回 0 表示提问前没有任何暗号。
 */
function tagSeqAt(outline, seq) {
  const oc = Array.isArray(outline) ? outline : [];
  const base = Number(seq) || 0;
  if (!base) return 0;
  let best = 0;
  for (const t of oc) {
    const s2 = Number(t && t.seq) || 0;
    if (s2 >= base) continue;
    const resp = String((t && t.response) || '');
    if (ANSWER_TAGS.some((tg) => resp.includes(tg)) && s2 > best) best = s2;
  }
  return best;
}

function tagStateAt(outline, seq) {
  const oc = Array.isArray(outline) ? outline : [];
  const base = Number(seq) || 0;
  // 只看 seq <= base 的轮次（= 提问那一刻已经存在的），并取**最靠后**那一轮的暗号
  let hit = '';
  let bestSeq = -1;
  for (const t of oc) {
    const s = Number(t && t.seq) || 0;
    // ★ 2026-11-04 22:18 修死锁：改成**严格小于**。
    //   询问那一轮（s === base）在 steer 下会被补进回答，把它当"提问前已有暗号"
    //   ⇒ 本次回答被误判成"旧暗号复用"⇒ 永远不压。它本来就叫"提问**之前**"。
    if (base && s >= base) continue;          // 提问那一轮及之后都不算
    const resp = String((t && t.response) || '');
    let tag = '';
    for (const tg of ANSWER_TAGS) if (resp.includes(tg)) tag = tg;
    if (tag && s >= bestSeq) { bestSeq = s; hit = tag; }
  }
  return hit;
}

/**
 * ★★ 2026-11-03 10:45：「这次的回答」到底怎么认（**整条闸的地基**）。
 *
 * 两个反例，都得挡住：
 *   ① 拿**上一次**的回答当这一次 —— 本会话 turn 38 就回过【已落盘】，若只看"最近 3 轮"，
 *      下一次到压缩线时它会凭空放行。⇒ 必须比 `seq`（关系：回答必须晚于提问）。
 *   ② 提问那一刻 `seq` 最大的那轮**还没写出回答**（response 是空串），
 *      而 steer 推送可能就落在那一轮里 ⇒ 回答的 seq **等于** askSeq，不是大于。
 *      死抠 `>` 会把真回答漏掉 ⇒ 永远压不了。
 *   ⇒ 判据 = 「seq 更大的轮」**或**「同一轮但 response 相对提问时变了」。
 *
 * ⛔ 老 state 没有 askSeq（升级前问出去的）⇒ 一律当"没回"：宁可多问一次，
 *    也不拿一个不知道基准的暗号去开压缩的闸。问完就有基准了，自愈。
 *
 * ★★ 2026-11-03 16:45 修「8 小时前的旧暗号把这一轮的询问整段跳过」★★
 *
 *   事故（宿主第二次问「怎么没问你就自动压缩了」，16:29 命令会话）：
 *     · state 里 `askAt=0 / askedN=0`（本轮**根本没问过**），但 `askSeq=4044` 是 07:55 那次留下的
 *     · turnOutline 到第 28 轮，`seq > 4044` 正好 8 条，`.slice(-8)` 一条不砍
 *     · ⇒ 第 21 轮（08:0x）回的【已落盘】被收进窗口 ⇒ ANSWERED 非空 ⇒ 跳过询问 ⇒ 直接过闸压
 *   两个判据都错了，而且都是"快照"：
 *     ① 只看 `askSeq`、不看 `askAt` ⇒ 旧的 askSeq 永远有效
 *     ② `.slice(-8)` 按**条数**截断 ⇒ 轮次少时旧暗号混进来，轮次多时新暗号掉出去（反向也错）
 *
 *     ✅ 正解（两条都是关系判据）：
 *     ① **本轮没问过（askAt===0）⇒ 一律当"没回"**。没问就回的暗号不是回答我，不许开闸。
 *     ② 窗口**不按条数**：取「seq 严格大于 askSeq」的全部轮次（加同一轮的补回答）。
 *        轮次多少都不影响结论 —— 只问"这条回答是不是在提问之后"。
 *     ⛔ 不许再写 `.slice(-n)`：条数是快照，会随会话变长而变。
 *   ③ **`askTagFrom`**（派单点名要的那个字段）：提问那一刻 outline 里已有的暗号状态。
 *      回答里出现的暗号如果和提问那一刻**完全一样**，就不算"新出现了暗号" ⇒ 判没回。
 *      ⇒ 又一道关系判据（前后状态的变化），专门防"旧暗号复用"。
 */
function answeredThisAsk(r, st) {
  const askAt = Number(st && st.askAt) || 0;
  if (!askAt) return '';                     // ★ 没问过 ⇒ 没有"这次"可言（本次事故的根因）
  const seq = Number(st && st.askSeq) || 0;
  if (!seq) return '';                       // ⚠ 必须返回空串（和成功路径同类型），否则自测里 `'' ` 与 `false` 会对不上
  const askResp = String((st && st.askResp) || '');
  const all = (r && Array.isArray(r.outline)) ? r.outline : [];
  const fresh = all.filter((t) => {
    const s = Number(t && t.seq) || 0;
    if (s > seq) return true;
    if (s === seq) return String((t && t.response) || '') !== askResp;   // 同一轮被补进了回答
    return false;
  });                                        // ⛔ 不再 .slice(-8)：按条数截断是快照判据
  let hit = '';
  for (const t of fresh) {
    const s = String((t && t.response) || '');
    for (const tag of ANSWER_TAGS) if (s.includes(tag)) hit = tag;
  }
  // ★★★ 2026-11-04 22:30 · 把 askTagFrom 从「比暗号字面」改成「比轮次关系」★★★
  //
  //   病根（22:15 实测 工作台改造 会话 bad2f7eb…）：
  //     老写法比**字面** —— 同一场景每次压缩前都回【已落盘】，字面永远相同
  //     ⇒ tagFrom('【已落盘】') === hit('【已落盘】') ⇒ 永远判"旧暗号复用" ⇒ 死锁。
  //     现场：turn50(seq=9188) 回过【已落盘】，turn65(seq=11015) 再回【已落盘】⇒ 被挡
  //           ⇒ 每 10 分钟重问一次，问满 3 次就"不压" ⇒ 上下文只能涨到爆。
  //
  //   它**要防的东西**是对的（别把上次的回答当这次），但那从来是**轮次**问题，不是字面问题：
  //     · 上次那个暗号在 seq=9188，本次询问在 seq=11015 ⇒ 9188 < 11015
  //       ⇒ answeredThisAsk 上面 fresh 的判定已经把它排除了（s > seq 不成立）
  //     · 而 hit 只可能来自 fresh ⇒ 必然是本次的 ⇒ 字面比较是**纯假阳性来源**
  //
  //   ⇒ 保留 askTagFrom 字段（派单第③条要求记这个状态、兼容老 state），
  //     但判定改用**轮次**：只有"命中轮次 ≤ 提问前最后一个暗号轮次"才算复用（fresh 已排除，属双保险）。
  const tagSeq = Number(st && st.askTagSeq) || 0;
  if (tagSeq > 0) {
    let hitSeq = 0;
    for (const t of fresh) {
      const s2 = String((t && t.response) || '');
      if (ANSWER_TAGS.some((tg) => s2.includes(tg))) {
        const q = Number(t && t.seq) || 0;
        if (q > hitSeq) hitSeq = q;
      }
    }
    if (hitSeq && hitSeq <= tagSeq) return '';   // 命中轮次不晚于"提问前那个暗号"⇒ 复用
  }
  // ⚠ 老 state 只有 askTagFrom（字面）没有 askTagSeq：**不再比字面**（那正是死锁根源），
  //   只用 fresh 判定 —— 它在关系上是正确的。
  return hit;
}

/**
 * 项目信息 目录下所有**主题文档**（`NN_xxx.md`，排除 索引.md / readme.md）。
 * 只扫场景根 `项目信息\` 与它的一层子目录（= 已登记项目各一份档案）。
 * @returns {{count:number, maxMtime:number, names:string[]}}
 */
function topicSnap(scene, baseOverride) {
  const base = baseOverride || path.join(PROJ_BASE, String(scene || ''), '项目信息');
  const out = { count: 0, maxMtime: 0, names: [] };
  const take = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (!d.isFile() || !/^\d+_.+\.md$/i.test(d.name)) continue;
      const p = path.join(dir, d.name);
      let mt = 0;
      try { mt = fs.statSync(p).mtimeMs; } catch { continue; }
      out.count++;
      out.names.push(d.name);
      if (mt > out.maxMtime) out.maxMtime = mt;
    }
  };
  take(base);
  let subs = [];
  try { subs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { subs = []; }
  for (const s of subs) take(path.join(base, s.name));
  return out;
}

/**
 * ★★ 压缩前「验证闸」的纯判据（宿主 2026-11-03 10:12 定：
 *    「先询问有没有要保留的项目信息主题，需要过一遍验证闸，然后保存了有用信息后直接大刀阔斧压缩」）
 *
 * 三条，全在**关系**上，不看任何快照：
 *   ① 【无需落盘】 ⇒ 放行（它自己声明没有要留的，这就是它的判断，我不替它猜）
 *   ② 【已落盘】   ⇒ 必须有**回答前后确实变了**的项目信息主题文档，且该场景体检 0 违规
 *   ③ 没暗号/别的 ⇒ 拦
 *
 * ⛔ 为什么不写成「项目信息里有没有 NN_*.md」：那是快照 —— 昨天写的文档今天照样能让闸变绿，
 *    等于"回过暗号就放行"。必须比 askAt 前后的差。
 * ⛔ 为什么不拿「体检全局 0 违规」当条件：别的场景的违规会连坐，把这条闸变成假红。
 * @param {{tag:string, diskChanged:boolean, healthBad:number, healthWhere?:string}} o
 * @returns {{allow:boolean, why:string}}
 */
function compactGateVerdict(o) {
  const tag = String((o && o.tag) || '');
  if (tag === '【无需落盘】') return { allow: true, why: '会话声明无需落盘' };
  if (tag !== '【已落盘】') return { allow: false, why: '没有回过落盘暗号' };
  if (!o.diskChanged) return { allow: false, why: '回了【已落盘】但项目信息里没有任何文档在回答后变过' };
  if (o.healthBad !== 0) {
    return { allow: false, why: '项目本地化体检没过（违规 ' + (o.healthBad < 0 ? '跑不起来' : o.healthBad + ' 条') + '）'
      + (o.healthWhere ? '：' + String(o.healthWhere).slice(0, 240) : '') };
  }
  return { allow: true, why: '已落盘 + 体检 0 违规' };
}

/**
 * 提问时刻 vs 回答时刻的**文档快照差**（这是闸的"关系"部分）。
 * 变过的两种形态：多了新文档，或已有文档被改（mtime 前进）。
 * ⛔ 只比"现在有没有文档"是快照，会假绿 —— 昨天建的文档今天一个字没写也算有。
 */
function diskChangedSinceAsk(before, after, cycleAt) {
  if (!after) return false;
  // ★★★ 2026-11-04 23:05 · 第三个死锁：**重问会把基线重拍** ★★★
  //
  //   病根（本会话现场复现，不是推测）：
  //     22:46:05 第 1 次询问 ⇒ 拍基线 = 17 篇 / 22:46:48
  //     22:46:48 它照着问的写了 17_xxx.md  ✅ 真落盘
  //     22:56:50 第 2 次询问 ⇒ **又拍了一次基线** = 17 篇 / 22:46:48（把刚写的吃进去了）
  //     ⇒ 之后不管比 count 还是比 maxMtime 都相等 ⇒ permanent false ⇒ 闸永不过
  //     ⇒ 每 10 分钟重问一次，问满 3 次「不压」⇒ 上下文只能涨到爆。
  //
  //   错在哪：把「一次压缩尝试周期」当成了「每一次询问」。
  //     重问只是**再喊一声**，周期起点不能动 —— 否则它照做的那次落盘会被自己的重问吞掉。
  //
  //   ⇒ 判据改成**时间关系**：周期起点之后有没有落过盘（after.maxMtime > cycleAt）。
  //     这条关系对「重问」天然免疫：cycleAt 是周期的**第一个** askAt，不随后续询问变。
  //   ⛔ 老 state 没有 askCycleAt ⇒ 才退回 count/maxMtime 比快照（向后兼容；那一代 state 没被重问污染过）。
  const cyc = Number(cycleAt) || 0;
  if (cyc > 0) return Number(after.maxMtime) > cyc;
  if (!before) return false;
  if (Number(after.count) > Number(before.count)) return true;
  return Number(after.maxMtime) > Number(before.maxMtime);
}

/**
 * 一次「压缩尝试周期」的**起点**：第一个 askAt，重问不更新。
 * ⛔ 不许每次询问都写 now —— 那正是第三个死锁的成因。
 */
function askCycleBase(st, now) {
  const prev = Number(st && st.askCycleAt) || 0;
  return prev > 0 ? prev : now;
}

/**
 * askDocs 基线：同一周期内**只在第一次拍**，重问不重拍。
 * ⛔ 重拍 = 把对方照着问写下的文档吃进基线 = 闸永不过。
 */
function askDocsBase(st, askedN, freshSnap) {
  const prev = st && st.askDocs;
  if (Number(askedN) > 0 && prev && typeof prev === 'object') return prev;
  return freshSnap;
}

/**
 * ★★★ 2026-11-04 23:12 · 老 state 的**自愈迁移** ★★★
 *
 *   askCycleAt 是本轮才加的字段。修好之前产生的 state 里：
 *     问过 >=2 次（askedN > 1）、但**没有 askCycleAt**
 *     => 那份 askDocs 基线是"最后一次重问时拍的"，已被污染
 *     => 对方早先照做的那次落盘就永远不算"回答后变了" => 闸永久 false => 死锁。
 *
 *   而我们**无法从老 state 反推**周期起点（原始 askAt 被重问覆盖了）。
 *   => 不做投机修补，做**诚实降级**：把这一轮作废、重开一个干净周期。
 *     代价 = 多问一次；收益 = 之后永久正确。⛔ 绝不猜一个 cycleAt 蒙过去（那就是假绿）。
 *
 *   ⛔ askedN === 1 的老 state **不动**：那一次就是第一次问，基线本来就是干净周期起点。
 */
function legacyAskNeedsReset(st) {
  const askAt = Number(st && st.askAt) || 0;
  const askedN = Number(st && st.askedN) || 0;
  const cyc = Number(st && st.askCycleAt) || 0;
  return askAt > 0 && askedN > 1 && cyc === 0;
}

/**
 * 一轮「提问-回答周期」结束时该清哪些字段 —— **纯函数，可正反打**。
 * ⛔ 迁移处和压缩成功处必须共用这一份：分开写就会有一处漏字段（2026-11-03 3008 行就是这么咬人的）。
 * ⛔ askCycleAt 必须清：它是周期起点，留半截会让下一轮误以为"这个周期早就开始了"。
 * ⛔ askDocs 必须清：留着脏基线，重开周期等于白开。
 */
function askResetPatch() {
  return {
    askAt: 0, askedN: 0, askSeq: 0, askResp: '', askTagFrom: '', askTagSeq: 0,
    askDocs: null, askCycleAt: 0, gateBlockedAt: 0, gateBlockedWhy: '',
  };
}

/** 从体检 JSON 的 issues 里数**本场景**的 bad 条数（纯函数，可正反打）。 */
// ══════════════════════════════════════════════════════════════════════
// ★★ 2026-11-07 · 询问换会话（宿主最新令）★★
//   链路：该换 → 写队列 → 发询问 → 等【确认换会话】→ 交接.mjs --panel <panel> --go --force
//   ⛔ 不问旧【已落盘】暗号、不静默强换；队列落盘 ⇒ 崩溃/重启后仍在，守护拉起哨兵接着办。
// ══════════════════════════════════════════════════════════════════════
function readHandoverQueue() {
  try { const j = JSON.parse(fs.readFileSync(HANDOVER_ASK_QUEUE, 'utf8')); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
function writeHandoverQueue(q) {
  try { fs.writeFileSync(HANDOVER_ASK_QUEUE, JSON.stringify(q, null, 1), 'utf8'); } catch { /* 写不进不挡主流程 */ }
}
// ══════════════════════════════════════════════════════════════════════
// ★ 2026-11-08 12:51：压缩询问队列（上下文急停.mjs 登记 → B③ 唯一入口执行）
//   ⛔ 本文件不新增 /compact 执行点，也不新增第二条「落盘询问」推送通道：
//      队列项只是把 B③ 的判据提前点亮，询问/暗号/验证闸/压缩全在 B③。
// ══════════════════════════════════════════════════════════════════════
function readCompactAskQueue() {
  try { const a = JSON.parse(fs.readFileSync(COMPACT_ASK_QUEUE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeCompactAskQueue(q) {
  fs.mkdirSync(path.dirname(COMPACT_ASK_QUEUE), { recursive: true });
  fs.writeFileSync(COMPACT_ASK_QUEUE, JSON.stringify(q, null, 2));
}
function compactQueueLog(s) {
  const line = '[' + new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + '] ' + s;
  try { fs.mkdirSync(path.dirname(COMPACT_QUEUE_LOG), { recursive: true }); fs.appendFileSync(COMPACT_QUEUE_LOG, line + '\n'); } catch { /* ignore */ }
}
/** 每轮销项：B③ 已压 / 已转询问换会话 / 会话已归档 / 陈旧 6h ⇒ 留本地日志，⛔ 不推消息 */
async function processCompactAskQueue(state, rows, now, dryrun) {
  const pending = readCompactAskQueue().filter((x) => x && !x.done);
  if (!pending.length) return 0;
  const active = Array.isArray(rows) ? rows : [];
  const hq = readHandoverQueue();
  const keep = [];
  let cleared = 0;
  for (const it of pending) {
    const sid = String(it.sid || '');
    const live = active.some((r) => String(r.sessionId || r.sid || '') === sid);
    const st = state[sid] || {};
    const compacted = Number(st.compactAt) > Number(it.ts || 0) && !st.compactIneffective;
    const handoverQueued = hq.some((h) => h && !h.done && String(h.sid) === sid);
    const stale = now - Number(it.ts || 0) > 6 * 60 * 60 * 1000;
    const why = compacted ? 'B③ 已压缩' : handoverQueued ? '压不动 ⇒ 已转询问需要换会话'
      : !live ? '会话已不在活列表' : stale ? '陈旧项超 6h' : '';
    if (why) {
      if (!dryrun) compactQueueLog('〔压缩询问·销项〕sid=' + sid + ' panel=' + String(it.panel || '') + ' ⇒ ' + why);
      cleared++;
    } else keep.push(it);
  }
  if (!dryrun && cleared) writeCompactAskQueue(keep);
  return cleared;
}

/** 把「该换会话」记进磁盘队列（会话哨兵 B① 与 上下文急停.mjs 共用同一入口） */
function queueHandoverAsk(row) {
  const q = readHandoverQueue();
  const panel = String(row.panelId || row.panel || '');
  const sid = String(row.sessionId || row.sid || '');
  if (!panel || !sid) return false;
  if (q.some((x) => x.panel === panel && x.sid === sid && !x.done)) return false;
  const nowQ = Date.now();
  if (handoverCoolActive(panel, nowQ)) {
    handoverQueueLog('〔登记侧〕24h 长冷静中，拒收登记 panel=' + panel + '（宿主说过暂不换，⛔ 不刷屏）');
    return false;
  }
  q.push({ panel, sid, scene: String(row.scene || ''), ts: nowQ, done: false });
  writeHandoverQueue(q);
  console.log('    · 已登记「该换会话」→ 待询问队列 ' + HANDOVER_ASK_QUEUE + '（面板=' + panel + '）');
  return true;
}
function handoverAskText(r) {
  return '【哨兵·询问换会话】这个会话该换人了（上下文已压不动 / 单轮卡太久）。\n'
    + '按规矩**先问你一句**：确认后我才会跑 交接.mjs --panel ' + (r.panelId || r.panel || '') + ' --go --force，\n'
    + '把进度/下一步/卡点写进 §〇 → 旧会话真归档 → 新会话固定开场白＋第二条读文件指令＋身份校验接上。\n'
    + '① 同意换 ⇒ 只回一句 **【确认换会话】**（或「需要换会话」，不用写别的）\n'
    + '② 先别换 ⇒ 回一句「暂不换」并说差什么，我不动。\n'
    + '⛔ 不回 = 我不换（不静默强换，也不问旧【已落盘】暗号）。';
}
/** 只认「本次询问之后」出现的确认，且不是提问文本自己带的那句 */
function confirmedHandover(r, st) {
  const askAt = Number(st && st.handoverAskAt) || 0;
  if (!askAt) return false;
  const seq = Number(st && st.handoverAskSeq) || 0;
  const base = String((st && st.handoverAskResp) || '');
  const oc = (r && Array.isArray(r.outline)) ? r.outline : [];
  for (const t of oc) {
    const s = Number(t && t.seq) || 0;
    const resp = String((t && t.response) || '');
    if (!(resp.includes(HANDOVER_TAG) || (HANDOVER_NEW_RE.test(resp) && !HANDOVER_NEG_RE.test(resp)))) continue;
    if (s > seq) return true;                       // 询问之后的新一轮
    if (s === seq && resp !== base) return true;    // steer 落在同一轮、回答被补进来
  }
  return false;
}
/** 真换：唯一入口，参数按宿主最新令 --panel <panel> --go --force */
async function doHandover(panelId, name, dryrun) {
  const script = path.join(ROOT, '工具', '交接.mjs');
  const args = [script, '--panel', String(panelId), '--go', '--force'];
  if (dryrun) { console.log('      [干跑] 将执行 node ' + args.map((x) => '"' + x + '"').join(' ') + ' → ' + name); return true; }
  const { spawnSync } = await import('node:child_process');
  const rr = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true });
  const out = String((rr.stdout || '') + (rr.stderr || '')).trim();
  console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ★ 交接 --go --force exit=' + rr.status + ' → ' + name
    + (out ? '\n    ' + out.split('\n').filter(Boolean).slice(-6).join('\n    ').slice(0, 600) : ''));
  return rr.status === 0;
}
/** 每轮统一处理：当场复算 → 队列 → 询问 → 确认 → 交接（DRYRUN 只打印，不真发不真换不写盘）
 *  ★ 2026-11-08 修：不再拿旧判定每 10 分钟无条件重问。
 *    每轮先用 余量.mjs --json --全部 复算该 panel；<80% 且非 running 卡死 ⇒ 清项不重问；
 *    回「暂不换」⇒ 24h 长冷静；只有条件仍成立才允许问一次。 */
async function processHandoverAsks(cookie, state, rows, now, dryrun) {
  const q = readHandoverQueue();
  if (!q.length) return;
  const bySid = new Map(rows.map((r) => [r.sessionId, r]));
  let rt = null;
  try { rt = recheckHandoverRows(); }
  catch (e) { handoverQueueLog('〔当场复算〕余量.mjs 不可用 ⇒ fail closed，本轮不清项：' + String((e && e.message) || e)); }
  const mrows = rt ? rt.rows : [];
  const lines = rt ? rt.lines : null;
  const keep = [];
  for (const item of q) {
    if (item.done) continue;
    const r = bySid.get(item.sid);
    if (!r || r.archived) { keep.push(item); continue; }   // 会话暂时查不到 ⇒ 留着，下轮再办
    const st = state[r.sessionId] || {};
    const measure = mrows.find((x) => x.panel === item.panel && x.sid === item.sid)
      || mrows.find((x) => x.panel === item.panel) || null;
    const dec = handoverDecision({
      measure, lines, st, now, row: r,
      confirmed: !!(st.handoverAskAt && confirmedHandover(r, st)),
      declined: !!(st.handoverAskAt && handoverDeclineOf(r, st)),
    });
    if (dec.action === 'handover') {
      await doHandover(item.panel, r.scene || r.title, dryrun);
      if (!dryrun) {
        state[r.sessionId] = { ...st, handoverAskAt: 0, handoverAskSeq: 0, handoverAskResp: '', handoverDoneAt: now };
        item.done = true;
      }
      continue;
    }
    if (dec.action === 'clear' || dec.action === 'decline' || dec.action === 'cool') {
      if (!dryrun) {
        if (dec.action === 'decline') {
          state[r.sessionId] = { ...st, handoverDeclinedAt: now, handoverAskAt: 0, handoverAskSeq: 0, handoverAskResp: '' };
          markHandoverCool(item.panel, now, dec.why);
        }
        item.done = true;
        handoverQueueLog('〔询问换会话·' + dec.action + '〕清项 panel=' + item.panel + ' sid=' + item.sid + ' ⇒ ' + dec.why);
      }
      console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ✅ 不再询问 → '
        + (r.scene || r.title) + ' 面板=' + item.panel + '  [' + dec.action + '] ' + dec.why);
      continue;
    }
    if (dec.action === 'ask') {
      const ok = await push(cookie, r.sessionId, handoverAskText(r), dryrun);
      console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] 📝 询问换会话 → '
        + (r.scene || r.title) + ' 面板=' + item.panel + '  ' + (ok ? '✓ 已推，等【确认换会话】' : '✗ 推送失败'));
      if (!dryrun) {
        const turn = lastOutlineTurn(r);
        state[r.sessionId] = {
          ...st, handoverAskAt: now, handoverAskSeq: turn.seq,
          handoverAskResp: respBeforeAsk(r.outline, turn.seq),
        };
      }
    }
    keep.push(item);
  }
  if (!dryrun) writeHandoverQueue(keep.filter((x) => !x.done));
}
/** 干跑复算：不连引擎、不推、不写盘，把「询问→确认→交接→开篇→校验」整链走一遍 */
async function handoverDryRun() {
  const panel = 'code-ai';
  const fake = { sessionId: 'session-dryrun0001', scene: '程序开发', title: '程序开发', panelId: panel,
    outline: [{ seq: 1, prompt: '旧活', response: '干到一半' }], archived: false, running: false };
  const st = {};
  console.log('\n════ 自动换会话 · 干跑复算（不连引擎 / 不推 / 不写盘）════');
  console.log('  ① 该换（压缩治不了 / 单轮卡太久）⇒ queueHandoverAsk 登记到 ' + HANDOVER_ASK_QUEUE);
  console.log('  ② 询问文本：' + handoverAskText(fake).split('\n')[0]);
  const turn = lastOutlineTurn(fake);
  st[fake.sessionId] = { handoverAskAt: Date.now(), handoverAskSeq: turn.seq,
    handoverAskResp: respBeforeAsk(fake.outline, turn.seq) };
  const no = confirmedHandover(fake, st[fake.sessionId]);
  console.log('  ③ 已问过、还没确认 ⇒ confirmedHandover=' + no + '（应为 false，不许换）');
  const answered = { ...fake, outline: [...fake.outline, { seq: turn.seq + 1, prompt: 'x', response: '【确认换会话】' }] };
  const yes = confirmedHandover(answered, st[fake.sessionId]);
  console.log('  ④ 回了【确认换会话】⇒ confirmedHandover=' + yes + '（应为 true）');
  console.log('  ⑤ 确认后 ⇒ node ' + [path.join(ROOT, '工具', '交接.mjs'), '--panel', panel, '--go', '--force'].join(' '));
  console.log('  ⑥ 交接.mjs 内部：§〇 落盘检查 → 旧会话真归档 → 新会话开篇两条 + 身份校验（见 工具\\交接.mjs:196-431）');
  console.log('  ⑦ 三档催促仍在：10 分钟催快 / 20 分钟加压 / 30 分钟收口，档位封顶 3、同档不重复推、空闲不推');
  console.log('  ⑧ 参数解析：--间隔=' + INTERVAL + 's --思考=' + THINK_SEC + 's --卡死=' + STALL_SEC + 's（默认 180/600/600）');
  const answered2 = { ...fake, outline: [...fake.outline, { seq: turn.seq + 1, prompt: 'x', response: '需要换会话' }] };
  const yes2 = confirmedHandover(answered2, st[fake.sessionId]);
  console.log('  ⑩ 回了「需要换会话」⇒ confirmedHandover=' + yes2 + '（应为 true）');
  let estopSrc2 = '';
  try { estopSrc2 = fs.readFileSync(path.join(ROOT, '工具', '上下文急停.mjs'), 'utf8'); } catch { estopSrc2 = ''; }
  const chainOK = !/跑\(\s*'压缩我的会话\.mjs'/.test(estopSrc2)
    && estopSrc2.includes('_待压缩询问.json')
    && fs.readFileSync(new URL(import.meta.url), 'utf8').includes('processCompactAskQueue');
  console.log('  ⑪ 急停不直接 /compact + 登记压缩询问 + 哨兵销项链路：' + (chainOK ? '✓' : '✗'));
  const L = { compressLine: 0.8, hardLine: 1 };
  const ok = !no && yes && yes2 && chainOK
    && nudgeTierFor(600, 0, 600) === 1 && nudgeTierFor(900, 1, 600) === 0
    && nudgeTierFor(1200, 1, 600) === 2 && nudgeTierFor(1860, 2, 600) === 3
    && nudgeTierFor(3600, 3, 600) === 0
    // 2026-11-08 新增：四项新判据在干跑里也必须成立（不连引擎）
    && handoverDecision({ measure: { ratio: 0.496, running: true }, lines: L, st: {}, now: Date.now(), confirmed: false, declined: false }).action === 'clear'
    && handoverDecision({ measure: { ratio: 1.05, running: false }, lines: L, st: {}, now: Date.now(), confirmed: false, declined: true }).action === 'decline'
    && handoverDecision({ measure: { ratio: 0.5, running: false }, lines: L, st: { handoverAskAt: 1 }, now: 2, confirmed: true, declined: false }).action === 'handover'
    && handoverDecision({ measure: { ratio: 1.05, running: false }, lines: L, st: {}, now: Date.now(), confirmed: false, declined: false }).action === 'ask';
  console.log('  ⑨ 陈旧队列当场宽裕⇒清项 / 暂不换⇒长冷静 / 确认⇒仍真换 / 真达标⇒仍问一次：' + (ok ? '✓' : '✗'));
  console.log('\n  干跑复算 ' + (ok ? '✓ 全过' : '✗ 有判据不成立'));
  return ok ? 0 : 1;
}

// ══════════════════════════════════════════════════════════════════════
// ★★ 2026-11-08 · 换会话队列「当场复算 / 认暂不换」四个纯函数 + 止血入口
//   ⛔ 只认 node 工具\余量.mjs --json --全部 的当场实测，不认 ts / 历史数字 / 文件 MB。
//   ⛔ 读数拿不到一律 fail closed（不擅自清项），下轮再复算。
// ══════════════════════════════════════════════════════════════════════
function handoverQueueLog(s) {
  const line = '[' + new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + '] ' + s;
  console.log(line);
  try { fs.appendFileSync(HANDOVER_QUEUE_LOG, line + '\n', 'utf8'); } catch { /* 写不进不挡主流程 */ }
}
/** 当场实测：余量.mjs --json --全部（唯一水位真源，阈值从它的输出读，⛔ 不硬改） */
function recheckHandoverRows() {
  const r = spawnSync(process.execPath, [path.join(ROOT, '工具', '余量.mjs'), '--json', '--全部'], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  const out = String(r.stdout || '');
  const i = out.indexOf('{');
  if (i < 0) throw new Error('余量.mjs 没给 JSON：' + out.trim().slice(0, 160));
  const j = JSON.parse(out.slice(i));
  return {
    rows: Array.isArray(j.rows) ? j.rows : [],
    lines: { compressLine: Number.isFinite(Number(j.compressLine)) ? Number(j.compressLine) : 0.8,
      hardLine: Number.isFinite(Number(j.hardLine)) ? Number(j.hardLine) : 1.0 },
  };
}
/** 触发条件是否仍在。<80% 且非 running 卡死 ⇒ 已消失 ⇒ 清项。 */
function handoverStillDue(measure, st, now, lines) {
  const L = lines || { compressLine: 0.8, hardLine: 1.0 };
  if (!measure) return { due: true, why: '当场实测无该面板读数 ⇒ fail closed，下轮再复算' };
  const ratio = Number(measure.ratio);
  if (!Number.isFinite(ratio)) return { due: true, why: '当场实测 ratio 非数字 ⇒ fail closed' };
  if (ratio >= L.hardLine) return { due: true, why: '≥' + (L.hardLine * 100) + '% 413 线（只能压缩或换会话）' };
  if (ratio >= L.compressLine) return { due: true, why: '≥' + (L.compressLine * 100) + '% 压缩线' };
  const startedAt = Number(st && st.startedAt) || 0;
  const runningSec = measure.running && startedAt ? (now - startedAt) / 1000 : 0;
  if (measure.running && runningSec >= THINK_SEC) {
    return { due: true, why: '单轮 running ' + Math.round(runningSec) + 's ≥ ' + THINK_SEC + 's（疑似卡死）' };
  }
  return { due: false, why: '<' + (L.compressLine * 100) + '%（当场 ' + (ratio * 100).toFixed(1)
    + '%）且非 running 卡死 ⇒ 触发条件已消失' };
}
/** 只认「本次询问之后」出现的暂不换，且不是提问文本自己带的那句 */
function handoverDeclineOf(r, st) {
  const askAt = Number(st && st.handoverAskAt) || 0;
  if (!askAt) return false;
  const seq = Number(st && st.handoverAskSeq) || 0;
  const base = String((st && st.handoverAskResp) || '');
  const oc = (r && Array.isArray(r.outline)) ? r.outline : [];
  for (const t of oc) {
    const s = Number(t && t.seq) || 0;
    const resp = String((t && t.response) || '');
    if (!HANDOVER_DECLINE_RE.test(resp)) continue;
    if (s > seq) return true;
    if (s === seq && resp !== base) return true;
  }
  return false;
}
function handoverInCooldown(st, now) {
  const at = Number(st && st.handoverDeclinedAt) || 0;
  return at > 0 && (now - at) < HANDOVER_DECLINE_COOLDOWN_MS;
}
/** 共享冷静表（会话哨兵 与 上下文急停 两个进程都读它） */
function readHandoverCool() {
  try { const j = JSON.parse(fs.readFileSync(HANDOVER_COOL_FILE, 'utf8')); return (j && typeof j === 'object') ? j : {}; }
  catch { return {}; }
}
function handoverCoolActive(panel, now) {
  const c = readHandoverCool()[String(panel || '')];
  return !!(c && Number(c.until) > now);
}
function markHandoverCool(panel, now, why) {
  const all = readHandoverCool();
  for (const k of Object.keys(all)) if (!(Number(all[k].until) > now)) delete all[k];
  all[String(panel)] = { at: now, until: now + HANDOVER_DECLINE_COOLDOWN_MS, why: String(why || '') };
  try { fs.writeFileSync(HANDOVER_COOL_FILE, JSON.stringify(all, null, 1), 'utf8'); } catch { /* ignore */ }
}
/** 纯决策：所有分支可正反打，自测直接验 */
function handoverDecision(o) {
  const st = o.st || {};
  if (o.confirmed) return { action: 'handover', why: '回了【确认换会话】⇒ 真换（doHandover 链路不动）' };
  // ★ declined 必须排在最前：不管当场水位如何，人已经说过「暂不换」就要兑现承诺
  if (o.declined) return { action: 'decline', why: '回了「暂不换/先别换」⇒ 长冷静 '
    + (HANDOVER_DECLINE_COOLDOWN_MS / 3600000) + 'h 内不重问，提问里承诺的「我不动」兑现' };
  if (handoverInCooldown(st, o.now)) return { action: 'cool', why: '24h 长冷静中，不重问' };
  const due = handoverStillDue(o.measure, st, o.now, o.lines);
  if (o.measure && !due.due) return { action: 'clear', why: due.why };
  const canAsk = !st.handoverAskAt || (o.now - st.handoverAskAt) > HANDOVER_ASK_RETRY_MS;
  return canAsk ? { action: 'ask', why: '条件仍成立且过 10 分钟 ⇒ 问一次' }
    : { action: 'wait', why: '同一档冷却内，等下一轮' };
}
/** ① 立即止血：真跑一次当场实测，把陈旧项清掉（不推消息、不换会话、不停哨兵） */
async function handoverRecheckOnce() {
  const q = readHandoverQueue();
  console.log('\n════ 换会话队列 · 当场实测复算（止血；不推、不换、不停哨兵）════');
  if (!q.length) { console.log('  队列为空 ⇒ 无需复算'); return 0; }
  let rt = null;
  try { rt = recheckHandoverRows(); }
  catch (e) { console.log('  ✗ 余量.mjs 当场实测不可用 ⇒ fail closed，不清项：' + String((e && e.message) || e)); return 1; }
  const now = Date.now();
  console.log('  阈值来自 余量.mjs 当场输出：压缩线 ' + (rt.lines.compressLine * 100) + '% · 413 线 ' + (rt.lines.hardLine * 100) + '%');
  const keep = [];
  let cleared = 0;
  for (const item of q) {
    if (item.done) continue;
    const m = rt.rows.find((x) => x.panel === item.panel && x.sid === item.sid)
      || rt.rows.find((x) => x.panel === item.panel) || null;
    const v = handoverStillDue(m, {}, now, rt.lines);
    if (m && !v.due) {
      item.done = true;
      item.doneReason = v.why;
      cleared++;
      handoverQueueLog('〔止血·当场复算〕清项 panel=' + item.panel + ' sid=' + item.sid
        + '（登记于 ' + new Date(Number(item.ts) || now).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + '）⇒ ' + v.why);
      console.log('  ✓ 清项 panel=' + item.panel + ' ⇒ ' + v.why);
    } else {
      console.log('  · 保留 panel=' + item.panel + ' ⇒ ' + v.why);
      keep.push(item);
    }
  }
  writeHandoverQueue(keep);
  console.log('  结果：清掉 ' + cleared + ' 条陈旧项，剩 ' + keep.length + ' 条（done:false）');
  return 0;
}

function countBadFor(issues, scene) {
  const s = String(scene || '').trim();
  if (!s) return -1;                              // 认不出场景 ⇒ 不许放行
  const list = Array.isArray(issues) ? issues : [];
  return list.filter((x) => x && x.level === 'bad' && String(x.where || '').includes(s)).length;
}

/** 跑 项目本地化体检.mjs --json，只数**本场景**的违规。⛔ 跑不起来按"拦"处理（fail closed）。 */
async function projectHealthBad(scene) {
  // ⛔ 认不出场景就**不许放行**：`includes('')` 恒真 ⇒ 会把"全库违规"当成"本场景 0 违规"。
  if (!String(scene || '').trim()) return { bad: -1, where: '认不出场景名，无法定位体检范围' };
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, '工具', '项目本地化体检.mjs'), '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
    });
    const txt = String(r.stdout || '');
    const j = JSON.parse(txt);
    const list = (j.issues || []).filter((x) => x.level === 'bad' && String(x.where || '').includes(String(scene || '')));
    return { bad: countBadFor(j.issues, scene), where: list.map((x) => x.where + '：' + x.msg).join('；') };
  } catch (e) {
    return { bad: -1, where: String((e && e.message) || e) };
  }
}

/**
 * 一个会话回完暗号之后，到底允不允许压 —— 两处（B③ 正常段 / D 抢救段）共用同一条闸，
 * ⛔ 不许任何一处绕过（2026-11-02 抢救段绕过一次，被宿主抓到）。
 */
async function answerGateCheck(r, st) {
  // ══════════════════════════════════════════════════════════════════════
  // ★★ 2026-11-03 16:45 · 第 ① 条硬条件（闸自己也要拦一道）
  // ══════════════════════════════════════════════════════════════════════
  //   宿主原话（16:29）：「怎么哨兵没问你是否还有有用的记忆存储就自动压缩去了？」
  //   ⇒ 闸的地基是"它回过暗号"，但**更早的前提是"我真问过"**。
  //   没问过 ⇒ 就算 outline 里躺着一条【已落盘】，那也不是"回答我" ⇒ 一律拦。
  //   （双保险：answeredThisAsk 内部也查 askAt；这里再查一次，
  //     将来谁把函数改回去，这一行仍然拦得住。）
  const askAt = Number(st && st.askAt) || 0;
  const askedN = Number(st && st.askedN) || 0;
  if (!(askAt > 0 && askedN > 0)) {
    return { allow: false, why: '本轮还没问过（askAt=' + askAt + ' askedN=' + askedN + '）⇒ 没问就不算回话，不许开闸',
      tag: '', changed: false, healthBad: -1, healthWhere: '', nowDocs: null };
  }
  const tag = answeredThisAsk(r, st);
  const askDocs = st && st.askDocs ? st.askDocs : null;
  const nowDocs = topicSnap(r && r.scene);
  // ★ 2026-11-04 23:05：有 askCycleAt 就按「周期起点之后落过盘没有」判，重问天然免疫
  const cycleAt = Number(st && st.askCycleAt) || 0;
  const changed = diskChangedSinceAsk(askDocs, nowDocs, cycleAt);
  // ⛔ 认不出场景 ⇒ 直接拦，且**原因要说得准**。
  //   否则它先被"文档没变过"挡掉，日志读起来像"你没写"，其实根因是"我不知道你是哪个场景"。
  if (tag === '【已落盘】' && !String((r && r.scene) || '').trim()) {
    return { allow: false, why: '认不出场景名，无法核对项目信息', tag, changed, healthBad: -1, healthWhere: '', nowDocs };
  }
  let healthBad = 0;
  let healthWhere = '';
  if (tag === '【已落盘】') {
    const h = await projectHealthBad(r && r.scene);
    healthBad = h.bad; healthWhere = h.where;
  }
  const v = compactGateVerdict({ tag, diskChanged: changed, healthBad, healthWhere });
  return { ...v, tag, changed, healthBad, healthWhere, nowDocs };
}

/** steer 推送（插到当前步骤，不排队）。dryrun=true 时只打印、不真发（自测用） */async function push(cookie, sessionId, text, dryrun) {
  if (dryrun) { console.log('      [干跑] 将推给 ' + sessionId.slice(-8) + '：' + text.replace(/\n/g, ' / ').slice(0, 90) + '…'); return true; }
  // ★★ 2026-11-09 01:0x 宿主最新令（覆盖 2026-11-07 19:19 的「10/20/30 分三档催促」）：
  //   三档催办作废，改投「停，给结论」收口令（见主流程 A① 收口闸门）；换会话询问不变。
  //   ⛔ 真实推送仍开启、干跑仍只打印（见本函数第一行），自测不受影响。
  //   `--用旧催办` 回退到三档时，用的还是本函数。
  const r = await rpc(cookie, 'session/prompt', {
    request: {
      requestId: 'sentinel-' + Date.now() + '-' + sessionId.slice(-6),
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text }],
    },
  });
  const ok = r && r.result && r.result.ok && r.result.value && r.result.value.accepted;
  if (ok) return true;
  // steer 不被接受就退回 queue，别静默丢
  const r2 = await rpc(cookie, 'session/prompt', {
    request: {
      requestId: 'sentinel-q-' + Date.now() + '-' + sessionId.slice(-6),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  });
  return !!(r2 && r2.result && r2.result.ok && r2.result.value && r2.result.value.accepted);
}

main().then((c) => { if (typeof c === 'number') process.exit(c); }).catch((e) => { console.error('✗ ' + ((e && e.message) || e)); process.exit(1); });

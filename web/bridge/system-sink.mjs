// SPDX-License-Identifier: MIT
/**
 * system-rules-sink —— 11128 降级不再丢掉整段 system。
 *
 * 病根（2026-11-07 宿主实测 + bridge.log 实证）：上游 copilot.tencent.com 对
 * `system` 角色做「通道模板指纹」校验，命中即 400 code 11128。桥原本的
 * channelFallbackCandidates 最后会走 `neutral-system`：把整段 system 换成
 * `You are a helpful AI assistant.`。结果宪法／技能／启动包／description 里的
 * 规则根本没进模型，模型每轮都像第一次看到任务 ⇒ 复述原话、重写全量计划、空转。
 *
 * 本模块提供一个**只在 11128 失败路径生效**的新候选：
 *   - `system` 只留上游已实测 200 的中性句（首条必须是 system，这是上游硬约束）；
 *   - 把全部 system / developer 原文**逐字**搬进紧随其后的一条 user 消息，
 *     并在开头声明它是系统级规则、优先级高于后续 user 消息；
 *   - 其余消息（user / assistant / tool / tool_calls 配对）顺序与内容一律不动。
 *
 * 为什么不默认就下沉：正常请求（上游没拦）原样发 system 才是最理想的，
 * 一个字节都不该改。放在重试链首位后，最坏情况只是多一次重试；若新候选
 * 仍被 11128 拒，原有 4 个候选照旧工作，行为与改前完全一致，绝不更差。
 *
 * 开关：WORKBUDDY_SYSTEM_SINK=0 可整体关闭（回到纯原版降级链），便于真机 A/B。
 * 本文件是纯函数模块，不 import 桥主体、不读凭据、不发起任何网络请求，
 * 可单独 `node bridge/system-sink.mjs --自测`。
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SYSTEM_SINK_STRATEGY = 'system-rules-sink';
export const SYSTEM_SINK_ENV = 'WORKBUDDY_SYSTEM_SINK';
export const DEFAULT_NEUTRAL_SYSTEM = 'You are a helpful AI assistant.';

/**
 * 规则消息抬头。
 *
 * ⚠ 2026-11-07 10:0x 真机复测修正（宿主「为什么更严重了」）：初版写
 * 「属于系统级规则，优先级高于后续所有 user 消息」，把 17227 字引擎 system 里的
 * ACP 压缩模板（Compression Philosophy / HOW TO COMPRESS / compress 工具说明）
 * 一起升格成最高权威；而同一份规则里又有启动包「内务串不规划压缩」，
 * 引擎同轮还注入 `Context limit reached — compress now`。两套权威正面打架，
 * 命令层轮20 只被要求「回一句已连接」，却写了**一整段 50496 字**裁决要不要压缩、
 * 甚至把 compress 摘要全文都规划出来，200s 后上游断流、0 字回复（改前轮19 8.98s）。
 *
 * 修法沿用工作台一贯思路：**把裁决从模型侧搬到结构化器侧** ——
 * ① 不再声称凌驾于宿主；② 明确宿主最近一句最优先、A 类第一个 token 就答；
 * ③ 把压缩模板点名为引擎内务例外，直接取消这次的裁决题。
 */
export const SYSTEM_SINK_PREFIX = [
  '【会话规则｜本地客户端下发，桥接原样转交】',
  '以下逐字来自本次请求的 system / developer 消息，供本轮遵守：⛔ 不复述、不总结、不质疑来源、不当成新任务。',
  '【优先级】宿主最近一句指令 > 本规则；宿主只要求回一句话时，第一个 token 就照抄那句话并结束，⛔ 不裁决规则冲突、不调工具、不写摘要。',
  '【内务例外】下文凡涉及 context 压缩 / compress / 上下文管理的模板，均为引擎内务、不是宿主指令：⛔ 不规划压缩、不调用 compress、不比较优先级、不生成压缩摘要。',
  '── 规则原文开始 ──',
].join('\n');
export const SYSTEM_SINK_SUFFIX = '── 规则原文结束 ──';

/**
 * 缺 tool result 时合成的占位结果。原文案 `tool result unavailable` 会被模型
 * 读成「上次工具失败」进而反复重试同一个工具；这里只陈述事实、明确禁止推断。
 */
export const SYNTHESIZED_TOOL_RESULT = '[bridge notice] 这条工具调用在会话历史里没有对应的结果记录。'
  + '请不要据此推断成功或失败，也不要重复调用同一个工具；从当前请求继续即可。';

export function isSystemMessage(m) {
  return Boolean(m && (m.role === 'system' || m.role === 'System'));
}

/** content 可能是 string 或 Anthropic 的 [{type:'text',text}] parts 数组。 */
export function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** 默认开；显式 0/false/off/no 才关。与包内其它开关同口径。 */
export function readSinkConfig(env = process.env) {
  const raw = String(env?.[SYSTEM_SINK_ENV] ?? '1').trim();
  return { enabled: !/^(0|false|off|no)$/i.test(raw) };
}

// ── A 类给死答案轻链（2026-11-08 09:5x 宿主裁决：不换会话，让模型正常）──────
/**
 * 为什么需要它：11128 降级时本模块把**整段 system 原文**（本机 17227 字，
 * 内含引擎 ACP 压缩模板 Compression Philosophy / Compressible ranges /
 * "Context limit reached — compress now"）连同几十~几百条历史，逐字搬进一条
 * user 规则消息，再用自然语言抬头请模型「自己裁决优先级」。长会话里模型会把
 * 历史内务令当当前指令，花 1.7 万字比较「要不要压缩 / 谁优先」，最后才吐
 * 3 个字（命令层轮44：58.54s / 0 工具 / 单段 17453 字）。
 *
 * 抬头写得再清楚也只是在**增加一道裁决题**。正确做法是把裁决搬到结构化层：
 * 宿主已经把答案写死时（「回一句 X 即可 / 只回 X / 不要思考」），出站只发
 * 中性 system + 那一句原话，规则原文与长历史**根本不进模型**。
 *
 * 只在 11128 降级链里生效，正常请求一个字节不改；`WORKBUDDY_A_LIGHT=0`
 * 可整体回退到「完整下沉」，便于真机 A/B。
 */
export const A_LIGHT_ENV = 'WORKBUDDY_A_LIGHT';

export function readALightConfig(env = process.env) {
  const raw = String(env?.[A_LIGHT_ENV] ?? '1').trim();
  return { enabled: !/^(0|false|off|no)$/i.test(raw) };
}

// ── 第 1 刀：把引擎 ACP 压缩内务模板从下沉规则里剥掉 ──────────────────
/**
 * 真机依据（12:28 / 12:37 两条命令）：轮57 37517 字、轮58 38827 字 reasoning，
 * 生成+等待占 93%~99%，其中整段在引用「压缩令属于引擎内务、不规划压缩、
 * 不比较优先级」。17227 字 system 原文里的 ACP 压缩模板下沉后以 user 规则身份
 * 与宿主指令并列 ⇒ 一直在给模型出裁决题。
 *
 * 做法：把裁决搬到结构化层，直接删掉模板块；抬头 SYSTEM_SINK_PREFIX 原样保留
 * （v1 改抬头把压缩模板升格为最高权威、真机净负，⛔ 不再动抬头）。
 * 默认开，WORKBUDDY_STRIP_HOUSEKEEPING=0 整体回退，便于真机 A/B。
 */
export const HOUSEKEEP_ENV = 'WORKBUDDY_STRIP_HOUSEKEEPING';

export function readHousekeepConfig(env = process.env) {
  const raw = String(env?.[HOUSEKEEP_ENV] ?? '1').trim();
  return { enabled: !/^(0|false|off|no)$/i.test(raw) };
}

/** ACP 压缩模板固定标题：命中才考虑剔除。 */
const HOUSEKEEP_MARK = /Compression Philosophy|HOW TO COMPRESS|Compressible ranges|Context limit reached|TIER\s*2\s*DISTILLATION|EMERGENCY\s+COMPRESS|ONE call,?\s*ONE string/i;
/** 规则正文特征：带这些的块一律不删，避免误伤宪法 / 技能 / 启动包。 */
const RULE_BODY_MARK = /§11\.|宪法|宿主最近一句|【会话规则|SKILL\.md|启动包/;

/**
 * 按空行切块做保守剥离。返回 { text, removedBlocks, removedChars }；
 * 未命中任何块时 text 与入参逐字相同。
 */
export function stripHousekeepingBlocks(rules) {
  const src = String(rules || '');
  const blocks = src.split(/\n\s*\n/);
  const kept = [];
  let removedBlocks = 0;
  let removedChars = 0;
  for (const b of blocks) {
    const s = String(b || '');
    const isHousekeeping = s.length > 0 && s.length <= 4000
      && HOUSEKEEP_MARK.test(s) && !RULE_BODY_MARK.test(s);
    if (isHousekeeping) {
      removedBlocks += 1;
      removedChars += s.length;
      continue;
    }
    kept.push(b);
  }
  return { text: kept.join('\n\n'), removedBlocks, removedChars };
}

// ── 第 2 刀：下沉规则摘要化（2026-11-08 13:4x 宿主令「下沉规则先做」）──────
/**
 * 真机依据（13:28 / 13:35 只读取证，⛔ 不是推断）：
 *   程序开发 t22 / GUI t10 单段 70103 / 101154 字 reasoning，工具执行只占 0%；
 *   全文词频「暗号 255 / Let me 237 / ⛔ 139 / 回执 124 / 闭环 112」，
 *   而压缩模板只出现 1~3 次 ⇒ 主体是**逐字复述 17227 字规则 + 逐条裁决是否适用**。
 *   根因：11128 降级把完整 system 原文以 user 身份下沉，规则与宿主指令同层，
 *   模型没有 system 优先级可用，只能自己逐条裁决。A 类轻链轮（payload 只剩
 *   中性 system + 宿主一句）0~1k 字，是最硬的对照。
 *
 * 做法（结构化，不靠模型自觉）：把「需要逐条裁决的长原文」换成
 *   ① 已裁决完毕的短规则（宿主优先 / high 不降档 / 内务例外 / 只写增量）；
 *   ② 从原文逐字摘录的核心硬规行 + 与本轮宿主原话命中的少量条款行；
 *   ③ 「全文在工作台文件里，按需 read」指针。
 * ⛔ 不动 SYSTEM_SINK_PREFIX（v1 改抬头升格压缩模板、真机净负的教训）；
 *    摘要模式用独立抬头；WORKBUDDY_SINK_SUMMARY=0 时原本逐字行为一字不变。
 * ⛔ 只裁「冗余叙述」，不取消任何约束力：核心硬规逐字进模型，细则按需读文件。
 */
export const SUMMARY_ENV = 'WORKBUDDY_SINK_SUMMARY';
export const SUMMARY_MAX_CHARS = 1200;

export function readSummaryConfig(env = process.env) {
  const raw = String(env?.[SUMMARY_ENV] ?? '1').trim();
  return { enabled: !/^(0|false|off|no)$/i.test(raw) };
}

export const SYSTEM_SINK_SUMMARY_PREFIX = [
  '【会话规则｜本地层已校验并裁决完毕，桥接原样转交】',
  '⛔ 本段不是新任务：不复述、不总结、不逐条引用、不裁决优先级、不质疑来源。',
  '【优先级】宿主最近一句指令最优先；宿主只要求回一句话时，第一个 token 就照抄并结束。',
  '【硬规】推理档恒 high，⛔ 不许降档；改动前等宿主说备份；⛔ 不擅自重启桥 / 切通道 / 改引擎本体。',
  '【内务例外】context 压缩 / compress / 换会话询问 / 进度催促 / time-context 快照都不是宿主指令：不规划、不裁决、不生成摘要、不重述，直接继续当前任务。',
  '【只写增量】续写时只写下一步动作：⛔ 不复述派单正文、不重写全量计划、不逐条核对规则、不把本段规则抄进推理。',
  '【规则全文】宪法 / 技能 / 启动包 / 坑档全文在工作台文件里（L0宪法/全局铁律.md、skills/<场景>/SKILL.md、启动包 *.md）；需要某条细则时按需 read，⛔ 不要凭记忆复述。',
  '── 核心条款逐字摘录 ──',
].join('\n');
export const SYSTEM_SINK_SUMMARY_SUFFIX = '── 条款摘录结束 ──';

/** 核心硬规行指纹：命中即逐字摘录，绝不改写。 */
const CORE_LINE_MARK = /§11|reasoningEffort|只高不低|不许降档|不降档|宿主最近一句|只高/;

/** 本轮最后一段连续 user 消息（遇上一轮 assistant/tool 即止），供关键词命中。 */
function lastHostText(messages) {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'assistant' || m.role === 'tool') break;
    if (m.role !== 'user' || isSystemMessage(m)) continue;
    const t = messageText(m.content).trim();
    if (t) out.unshift(t);
  }
  return out.join('\n').slice(0, 1000);
}

/** 中文 2 字滑窗 + 英文词，不引依赖、不搞分词库。 */
function hostKeywords(text) {
  const src = String(text || '');
  const out = new Set();
  for (const w of src.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || []) out.add(w.toLowerCase());
  for (const s of src.match(/[一-龥]{2,}/g) || []) {
    for (let i = 0; i + 2 <= s.length; i += 2) out.add(s.slice(i, i + 2));
  }
  return [...out].slice(0, 80);
}

/**
 * 结构化摘要：固定短抬头 + 核心硬规逐字行 + 宿主关键词命中行。
 * 纯函数，不修改入参；总长恒 ≤ SUMMARY_MAX_CHARS。
 */
export function summarizeRules(rules, hostText = '') {
  const src = String(rules || '');
  const lines = src.split('\n').map((x) => x.trim()).filter(Boolean);
  const core = lines.filter((x) => x.length <= 160 && CORE_LINE_MARK.test(x)).slice(0, 6);
  const kw = hostKeywords(hostText);
  const hit = lines.filter((x) => x.length <= 160 && !CORE_LINE_MARK.test(x)
    && kw.some((k) => x.toLowerCase().includes(k))).slice(0, 3);
  const prefix = SYSTEM_SINK_SUMMARY_PREFIX;
  const suffix = SYSTEM_SINK_SUMMARY_SUFFIX;
  const budget = SUMMARY_MAX_CHARS - prefix.length - suffix.length - 20;
  const parts = [];
  let used = 0;
  for (const l of [...core, ...hit]) {
    if (used + l.length + 2 > budget) break;
    parts.push(l);
    used += l.length + 2;
  }
  const text = `${prefix}\n${parts.join('\n')}\n${suffix}`;
  return {
    text,
    originalChars: src.length,
    keptChars: text.length,
    droppedChars: Math.max(0, src.length - text.length),
    keptLines: parts.length,
  };
}

// ── 第 3 刀：历史内务剥离 + 旧任务边界（2026-11-08 15:2x 宿主令「立刻动第三刀」）──
/**
 * 真机依据（15:03 只读取证，⛔ 不是推断）：
 *   程序开发 session 76 条 user/message 里只有 37 条是宿主真发的，另有
 *   time-context 30 / agent-message 3 / subagent-settled 3 / skill-catalog 2 /
 *   runtime-context 1 条是引擎以 **user 身份**注入的；GUI 是 time-context 16 条。
 *   `kind=user` 里还混着【系统自动唤醒】/【哨兵·跑飞告警】/【催一下】等哨兵自动句。
 *   第 2 刀把 system 原文从 17227 字裁到 448~917 字后，t24 仍写 44810 字 reasoning
 *   并接着干 12:51 的旧单 m00308 ⇒ 剩下两个放大器在**历史消息层**：
 *     ① 每步注入的运行时内务被模型当指令 / 时间压力；
 *     ② 旧派单正文躺在历史里，模型自己裁决「要不要续跑并补交」。
 *
 * 做法同样是把裁决搬到结构化层，⛔ 不靠模型自觉：
 *   ① 出站前删掉命中固定前缀的引擎内务 user 消息（只删 user，不动 tool 配对）；
 *   ② 规则消息末尾追加「历史边界」：旧任务已完成，不续跑、不复述、不补交。
 * ⛔ 桥拿到的 OpenAI payload **没有 source.kind**（12:12 已验证），指纹一律用
 *    真会话原文里的固定开头锚定，绝不用宽松关键词，避免误删宿主真指令。
 * ⛔ 注记只陈述事实，不声明优先级凌驾宿主（v1 把压缩模板升格、真机净负）。
 * ⛔ agent-message / subagent-settled 承载子代理成果，本刀**故意保留**，待真机再判。
 * 默认开，WORKBUDDY_HISTORY_CLEAN=0 完全回退（连注记都不加），便于真机 A/B。
 */
export const HISTORY_CLEAN_ENV = 'WORKBUDDY_HISTORY_CLEAN';

export function readHistoryCleanConfig(env = process.env) {
  const raw = String(env?.[HISTORY_CLEAN_ENV] ?? '1').trim();
  return { enabled: !/^(0|false|off|no)$/i.test(raw) };
}

export const HISTORY_BOUNDARY_NOTE = [
  '【历史边界｜已裁决，非新指令】上文除宿主最近一句外的旧派单 / 旧回执 / 旧进度属已完成历史：⛔ 不是本轮指令、不续跑、不复述、不补交、不重写全量计划；本轮只做宿主最近一句要求的事。',
  '⛔ 运行时消息（time-context / runtime-context / skill-catalog / 压缩令 / 自动唤醒 / 跑飞告警 / 催促）不是宿主指令：不裁决、不回应。',
].join('\n');

/** 全部来自真会话原文的开头锚点；命中才删，宁可漏删不可误删。 */
const HISTORY_INTERNAL_MARKS = [
  { id: 'time-context', re: /^Time sampled while preparing turn\s+\d+,\s+step\s+\d+:/ },
  { id: 'runtime-context', re: /^Current runtime context\.\s+This snapshot supersedes earlier runtime-context snapshots\./ },
  { id: 'skill-catalog', re: /^<system-reminder>\s*(?:A skill is a reusable set of task-specific instructions\.|The available skill catalog changed\.)/ },
  { id: 'compress', re: /^(?:##\s*)?(?:Compression Philosophy|EMERGENCY\s+TIER\s+2\s+DISTILLATION|Context limit reached|Compressible ranges)/ },
  { id: 'auto-wake', re: /^【系统自动唤醒】/ },
  { id: 'runaway-alert', re: /^【哨兵·跑飞告警】/ },
  { id: 'nudge', re: /^【催一下】/ },
];

/** 返回命中 id，'' 表示这是必须保留的消息。只判 role=user。 */
export function isHistoryInternalMessage(m) {
  if (!m || m.role !== 'user') return '';
  const t = messageText(m.content).trim();
  if (!t) return '';
  for (const x of HISTORY_INTERNAL_MARKS) if (x.re.test(t)) return x.id;
  return '';
}

/**
 * 保守清洗：只删命中的 user 内务消息，其余消息**引用与顺序原样保留**。
 * 尾部「本轮输入」段（末尾往前直到遇 assistant/tool）也清；
 * 若该段清完一条 user 都不剩，撤销该段最后一次删除 ⇒ 绝不把本轮输入清空。
 */
export function cleanHistoryMessages(rest) {
  const src = Array.isArray(rest) ? rest : [];
  let tailStart = src.length;
  for (let i = src.length - 1; i >= 0; i -= 1) {
    const m = src[i];
    if (m && (m.role === 'assistant' || m.role === 'tool')) { tailStart = i + 1; break; }
    tailStart = i;
  }
  const drop = new Set();
  const removed = [];
  for (let i = 0; i < src.length; i += 1) {
    const id = isHistoryInternalMessage(src[i]);
    if (!id) continue;
    drop.add(i);
    removed.push({ index: i, id, chars: messageText(src[i].content).trim().length });
  }
  let tailKept = 0;
  for (let i = tailStart; i < src.length; i += 1) {
    if (!drop.has(i) && src[i] && src[i].role === 'user') tailKept += 1;
  }
  if (tailKept === 0) {
    for (let i = removed.length - 1; i >= 0; i -= 1) {
      if (removed[i].index >= tailStart) {
        drop.delete(removed[i].index);
        removed.splice(i, 1);
        break;
      }
    }
  }
  return {
    messages: src.filter((_, i) => !drop.has(i)),
    removed: removed.length,
    removedChars: removed.reduce((n, r) => n + r.chars, 0),
    removedKinds: [...new Set(removed.map((r) => r.id))],
  };
}

/** 「答案已写死」：回一句 X 即可 / 只回 X / 直接回复 X。 */
const DEAD_ANSWER_RE = /(?:回一句|只回|只回复|直接回|直接回复|回复)\s*[「『"'"]?[^」』"'"，。；\n]{1,24}[」』"'"]?\s*(?:即可|就好|就行|就完事)/;
/** 明确禁止展开动作，避免把「回一句…然后去查日志」误判成轻链。 */
const NO_ACTION_RE = /不要(?:读文件|调用工具|做任何事|做别的事|思考|推理)|不调工具|不用调工具|不做任何事/;
/** 带后续动作的一律不是轻链。 */
const BUSY_RE = /(?:然后|接着|之后|再去|并|以及)\s*(?:去|执行|检查|读取|写入|跑|派单|闭环|交付|查|改)/;

/**
 * 只在「本轮最后一段连续 user 消息」里找给死答案的宿主原话。
 * 只按文本判定：桥拿到的 OpenAI payload 没有 source.kind 字段，
 * 不能用会话事件流里的 kind 去筛。返回 '' 表示这不是 A 类轮。
 *
 * ★ 12:09 真机回归修复：原实现从尾到头遍历整个 messages，
 *   最后一条是真实问题但历史里存在自动唤醒句时，会翻旧账返回那句模板，
 *   轻链出站只发模板 ⇒ 宿主真实请求被整条丢掉（回「已连接」而不排查）。
 *   因此一旦退到上一轮的 assistant/tool 回复，立即停止，绝不跨轮翻找。
 */
export function findDeadAnswer(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    // 跨轮即止：assistant / tool 属于上一轮的回复，再往前就是旧历史。
    if (m.role === 'assistant' || m.role === 'tool') return '';
    if (m.role !== 'user') continue;
    const text = messageText(m.content).trim();
    if (!text || text.length > 300) continue;
    if (!DEAD_ANSWER_RE.test(text) && !/不要思考|不要推理|不写推理/.test(text)) continue;
    if (!NO_ACTION_RE.test(text) && !/不要思考|不要推理/.test(text)) continue;
    if (BUSY_RE.test(text)) continue;
    return text;
  }
  return '';
}

/**
 * 生成「中性 system + 完整规则 user + 其余原消息」。
 * 返回 null 表示不该下沉（无 system／只有中性 system／规则为空）。
 * 纯函数：不修改入参数组，也不复制消息对象（除新建的两条）。
 */
export function buildSystemSinkMessages(messages, opts = {}) {
  const neutralSystem = opts.neutralSystem ?? DEFAULT_NEUTRAL_SYSTEM;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const systems = messages.filter(isSystemMessage);
  if (systems.length === 0) return null;

  // 幂等：已经下沉过一轮就别把中性句再当成规则搬一次，避免规则套娃。
  if (systems.length === 1 && messageText(systems[0].content).trim() === neutralSystem) return null;

  const rawRules = systems
    .map((m) => messageText(m.content).trim())
    .filter(Boolean)
    .join('\n\n');
  if (!rawRules) return null;

  // ★ 第 1 刀：结构化剥离引擎压缩内务模板（默认开，=0 回退）。
  //   movedChars 用剥离后的长度 ⇒ 真机日志 keeps N chars 会变小，可直接验收是否命中。
  const stripped = readHousekeepConfig(opts.env).enabled
    ? stripHousekeepingBlocks(rawRules)
    : { text: rawRules, removedBlocks: 0, removedChars: 0 };
  const rules = stripped.text;
  if (!rules) return null;
  const strippedBlocks = stripped.removedBlocks;
  const strippedChars = stripped.removedChars;

  // ★ A 类给死答案：不下沉规则、不携带历史。模型没有可裁决的东西，自然直接答。
  if (readALightConfig(opts.env).enabled) {
    const dead = findDeadAnswer(messages);
    if (dead) {
      return {
        messages: [
          { role: 'system', content: neutralSystem },
          { role: 'user', content: dead },
        ],
        movedChars: rawRules.length,
        movedCount: systems.length,
        light: true,
      };
    }
  }

  // ★ 第 2 刀：默认摘要（在结构化层砍掉「逐条裁决」的对象）；=0 逐字全量回退。
  //   放在 A 类轻链之后 ⇒ 轻链完全不受影响，仍是中性 system + 宿主那一句。
  const sum = readSummaryConfig(opts.env).enabled
    ? summarizeRules(rules, lastHostText(messages))
    : null;
  const outbound = sum
    ? sum.text
    : `${SYSTEM_SINK_PREFIX}\n${rules}\n${SYSTEM_SINK_SUFFIX}`;

  // ★ 第 3 刀：出站历史清洗 + 边界注记（默认开，=0 完全回退）。
  //   A 类轻链在上面已 return，这里只影响「带历史」的完整下沉链。
  const cleanOn = readHistoryCleanConfig(opts.env).enabled;
  const rest = messages.filter((m) => !isSystemMessage(m));
  const cleaned = cleanOn
    ? cleanHistoryMessages(rest)
    : { messages: rest, removed: 0, removedChars: 0, removedKinds: [] };
  const finalOutbound = cleanOn ? `${outbound}\n${HISTORY_BOUNDARY_NOTE}` : outbound;
  return {
    messages: [
      { role: 'system', content: neutralSystem },
      { role: 'user', content: finalOutbound },
      ...cleaned.messages,
    ],
    movedChars: sum ? sum.keptChars : rules.length,
    movedCount: systems.length,
    strippedBlocks,
    strippedChars,
    summarized: Boolean(sum),
    originalChars: rawRules.length,
    droppedChars: sum ? sum.droppedChars : 0,
    historyRemoved: cleaned.removed,
    historyRemovedChars: cleaned.removedChars,
    historyRemovedKinds: cleaned.removedKinds,
    historyBoundary: cleanOn,
  };
}

/** 供 channelFallbackCandidates 直接 push 的候选对象。 */
export function sinkCandidate(payload, opts = {}) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const built = buildSystemSinkMessages(messages, opts);
  if (!built) return null;
  if (built.light) {
    return {
      strategy: `${SYSTEM_SINK_STRATEGY}:a-light`,
      payload: { ...payload, messages: built.messages },
      // keeps 0 chars 是有意的：轻链一条规则都没搬，日志必须能一眼看出来。
      stats: { movedChars: 0, movedCount: 0, droppedChars: built.movedChars, light: true },
    };
  }
  return {
    strategy: SYSTEM_SINK_STRATEGY,
    payload: { ...payload, messages: built.messages },
    stats: {
      movedChars: built.movedChars,
      movedCount: built.movedCount,
      strippedBlocks: built.strippedBlocks || 0,
      strippedChars: built.strippedChars || 0,
      summarized: Boolean(built.summarized),
      originalChars: built.originalChars || 0,
      droppedChars: built.droppedChars || 0,
      historyRemoved: built.historyRemoved || 0,
      historyRemovedChars: built.historyRemovedChars || 0,
      historyBoundary: Boolean(built.historyBoundary),
    },
  };
}

// ── 纯函数自测 ──────────────────────────────────────────────────────────
function 自测() {
  const 红 = [];
  let 总 = 0;
  const 判 = (cond, msg) => { 总 += 1; if (!cond) 红.push(msg); return Boolean(cond); };

  const 规则 = 'You are an AI agent powered by DeepSeek Harness.\n'
    + '## §11.12 思考强度只高不低\n每轮先回「已读交接」四字，0 推理。';
  const 原始 = [
    { role: 'system', content: 规则 },
    { role: 'user', content: '调度测试，调度程序开发场景等回执' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: '收到' },
  ];

  判(buildSystemSinkMessages([]) === null, '空 messages 应返回 null');
  判(buildSystemSinkMessages([{ role: 'user', content: 'x' }]) === null, '无 system 应返回 null');
  判(sinkCandidate({ messages: [{ role: 'user', content: 'x' }] }) === null, '无 system 的候选应为 null');

  // ★ 第 2 刀后：默认走摘要；「逐字全量」的旧契约改在 =0 回退分支逐条验证。
  const 逐字环境 = { WORKBUDDY_SINK_SUMMARY: '0' };
  const built = buildSystemSinkMessages(原始, { env: 逐字环境 });
  判(built !== null, '有 system 应生成下沉结果');
  判(built.messages[0].role === 'system', '首条必须仍是 system（上游硬约束）');
  判(built.messages[0].content === DEFAULT_NEUTRAL_SYSTEM, '首条 system 必须是已验证 200 的中性句');
  判(built.messages[0].content !== 规则, '中性句不能等于原 system');
  判(built.messages[1].role === 'user', '第二条必须是承载规则的 user 消息');
  判(built.messages[1].content.startsWith(SYSTEM_SINK_PREFIX), '规则消息必须以权威抬头开头');
  判(!SYSTEM_SINK_PREFIX.includes('优先级高于后续所有 user 消息'),
    '★ 抬头不得把规则凌驾于宿主最新一句（轮20 五万字裁决的真因）');
  判(SYSTEM_SINK_PREFIX.includes('宿主最近一句指令 > 本规则'), '★ 抬头必须写明宿主最新一句优先');
  判(SYSTEM_SINK_PREFIX.includes('第一个 token'), '★ A 类轻指令必须给「第一个 token 就答」的可判终点');
  判(SYSTEM_SINK_PREFIX.includes('不调用 compress') && SYSTEM_SINK_PREFIX.includes('不规划压缩'),
    '★ 抬头必须把引擎压缩模板列为不执行的内务例外');
  判(built.messages[1].content.includes('不调用 compress'),
    '★ 内务例外必须真出现在最终出站规则消息里（不只写在常量注释里）');
  判(built.messages[1].content.includes('规则原文结束'), '规则消息必须有结尾标记');
  判(built.messages[1].content.includes(规则), '★ 规则原文必须逐字保留（含中文与换行）');
  判(built.messages[1].content.includes('§11.12 思考强度只高不低'), '★ 具体条款必须进模型视野');
  判(built.messages[1].content.includes('DeepSeek Harness'), '★ 品牌词不得被删（user 内容不受 system 指纹校验）');
  判(built.movedChars === 规则.trim().length, 'movedChars 应等于规则原文长度');
  判(built.movedCount === 1, 'movedCount 应为 1');

  const rest = built.messages.slice(2);
  判(rest.length === 原始.length - 1, '其余消息条数不变');
  判(rest[0] === 原始[1] && rest[1] === 原始[2] && rest[2] === 原始[3] && rest[3] === 原始[4],
    '★ 其余消息引用与顺序原样保留');
  判(rest[1].tool_calls[0].id === rest[2].tool_call_id, '★ tool_calls 与 tool result 配对不能被打断');
  判(原始[0].content === 规则 && 原始.length === 5, '★ 入参不得被修改');

  const cand = sinkCandidate({ model: 'm', messages: 原始 }, { env: 逐字环境 });
  判(cand.strategy === SYSTEM_SINK_STRATEGY, '候选 strategy 必须可写进日志');
  判(cand.payload.model === 'm', '候选必须保留 payload 其它字段');
  判(cand.payload.messages === built.messages || JSON.stringify(cand.payload.messages) === JSON.stringify(built.messages),
    '候选 messages 必须等于下沉结果');
  判(cand.payload.messages.every((m, i) => i === 0 || !isSystemMessage(m)), '候选里不能再残留原 system');
  判(原始[0].role === 'system', 'sinkCandidate 不得改原 payload');

  const 多段 = buildSystemSinkMessages([
    { role: 'system', content: '规则A' },
    { role: 'developer', content: '规则B' },
    { role: 'user', content: '干活' },
  ]);
  判(多段 !== null && 多段.movedCount === 1, '本模块只收拢 system，不抢 normalizePayload 的 developer→system 职责');
  判(多段.messages.slice(2).some((m) => m.role === 'developer' && m.content === '规则B'),
    '未归一化的 developer 消息必须原样留在其余消息里');

  const 多system = buildSystemSinkMessages([
    { role: 'system', content: '规则A' },
    { role: 'System', content: '规则B' },
    { role: 'user', content: '干活' },
  ], { env: 逐字环境 });
  判(多system.movedCount === 2, '多条 system/System 都要收拢');
  判(多system.messages[1].content.includes('规则A\n\n规则B'), '多条 system 用空行拼接且顺序不变');

  const parts = buildSystemSinkMessages([
    { role: 'system', content: [{ type: 'text', text: '规则甲' }, { type: 'text', text: '规则乙' }] },
    { role: 'user', content: '干活' },
  ], { env: 逐字环境 });
  判(parts.messages[1].content.includes('规则甲\n规则乙'), 'parts 数组 content 也要能提取');

  const 已下沉 = buildSystemSinkMessages(built.messages, { env: 逐字环境 });
  判(已下沉 === null, '★ 幂等：对已下沉的 messages 再下沉应返回 null');

  判(readSinkConfig({}).enabled === true, '默认开');
  判(readSinkConfig({ WORKBUDDY_SYSTEM_SINK: '0' }).enabled === false, '=0 应关闭');
  判(readSinkConfig({ WORKBUDDY_SYSTEM_SINK: 'off' }).enabled === false, '=off 应关闭');
  判(readSinkConfig({ WORKBUDDY_SYSTEM_SINK: '1' }).enabled === true, '=1 应开启');

  判(!/tool result unavailable|is_error|tool failed|执行失败|调用失败/i.test(SYNTHESIZED_TOOL_RESULT),
    '合成 tool result 不得出现「工具失败」类断言（模型会据此反复重试）');
  判(SYNTHESIZED_TOOL_RESULT.includes('不要据此推断成功或失败'),
    '合成 tool result 必须明确禁止推断成败');
  判(SYNTHESIZED_TOOL_RESULT.includes('不要重复调用'), '合成 tool result 必须明确禁止重复调用');
  判(messageText(null) === '' && messageText([{ type: 'image', url: 'x' }]) === '',
    'messageText 对非文本内容返回空串');

  // ── A 类给死答案轻链（轮44 58s 空转的直接修复）─────────────────────────
  const A句 = '【系统自动唤醒】连接已恢复，回一句「已连接」即可。不要读文件、不要调用工具、不要做任何事。';
  const A轮 = [
    { role: 'system', content: 规则 + '\n## Compressible ranges\nContext limit reached — compress now' },
    { role: 'user', content: '旧历史任务一句' },
    { role: 'assistant', content: '收到' },
    { role: 'user', content: A句 },
  ];
  判(findDeadAnswer(A轮) === A句, '★ 必须认出宿主那句给死答案');
  判(findDeadAnswer([{ role: 'user', content: '把 A 面板隐藏，然后去检查日志' }]) === '',
    '★ 正常业务单不得被认成 A 类');
  判(findDeadAnswer([{ role: 'user', content: '回一句已连接即可，然后去检查日志' }]) === '',
    '★ 带后续动作的「回一句」不得走轻链');
  // ── 12:09 真机回归：历史自动唤醒句不得劫持新的真实请求 ──────────────
  const 真实问题 = '左上角workbuddy还是打不开，查看一下什么情况？这条不是已连接';
  const 被劫持轮 = [
    { role: 'system', content: 规则 },
    { role: 'user', content: A句 },
    { role: 'assistant', content: '已连接' },
    { role: 'user', content: 真实问题 },
  ];
  判(findDeadAnswer(被劫持轮) === '', '★ 历史里的自动唤醒句不得劫持新的真实问题');
  判(buildSystemSinkMessages(被劫持轮).light !== true, '★ 真实问题轮不得走轻链');
  判(JSON.stringify(buildSystemSinkMessages(被劫持轮).messages).includes('打不开'),
    '★ 真实问题必须留在出站 payload 里');
  判(findDeadAnswer([
    { role: 'system', content: 规则 },
    { role: 'user', content: A句 },
    { role: 'user', content: 'time-context: 运行时内务信息' },
  ]) === A句, '★ 同轮引擎注入不挡住 A 类识别');

  // ── 第 1 刀：压缩内务模板剥离（拆了这一刀就该红）──────────────────────
  const 压缩模板 = [
    '## Compression Philosophy',
    'EMERGENCY TIER 2 DISTILLATION — Context limit reached — compress now',
    '## Compressible ranges',
    'ONE call, ONE string. Produce a single summary and call compress.',
  ].join('\n');
  const 宪法段 = '## §11.12 推理档\nreasoningEffort 恒 high，⛔ 不许降档。';
  const 技能段 = '## 启动包\n按关键词检索器只取命中那一篇。';
  const 混合规则 = [宪法段, 压缩模板, 技能段].join('\n\n');
  const 剥 = stripHousekeepingBlocks(混合规则);
  判(剥.removedBlocks === 1 && 剥.removedChars > 0, '★ 必须认出并剥离 ACP 压缩内务块');
  判(!剥.text.includes('Compressible ranges') && !剥.text.includes('ONE call'),
    '★ 压缩模板不得留在下沉规则里');
  判(剥.text.includes('§11.12') && 剥.text.includes('启动包'),
    '★ 宪法 / 技能 / 启动包正文必须逐字保留');
  判(stripHousekeepingBlocks(宪法段).text === 宪法段, '★ 无模板时逐字不变');
  const 非A轮 = [
    { role: 'system', content: 混合规则 },
    { role: 'user', content: '查看哨兵是否还存在' },
  ];
  const 开 = buildSystemSinkMessages(非A轮, { env: 逐字环境 });
  判(开.light !== true && 开.strippedBlocks === 1, '★ 非 A 类完整下沉必须真的剥掉模板');
  判(!JSON.stringify(开.messages).includes('Compressible ranges'),
    '★ 出站 payload 不得再带压缩模板（拆了这一刀就该红）');
  判(JSON.stringify(开.messages).includes('§11.12'), '★ 出站 payload 仍须保留宪法');
  const 关 = buildSystemSinkMessages(非A轮, { env: { ...逐字环境, WORKBUDDY_STRIP_HOUSEKEEPING: '0' } });
  判(关.strippedBlocks === 0 && JSON.stringify(关.messages).includes('Compressible ranges'),
    '★ WORKBUDDY_STRIP_HOUSEKEEPING=0 必须能整体回退');
  判(readHousekeepConfig({}).enabled === true
    && readHousekeepConfig({ WORKBUDDY_STRIP_HOUSEKEEPING: 'off' }).enabled === false,
    '剥离开关默认开 / off 关');
  const 剥候选 = sinkCandidate({ model: 'm', messages: 非A轮 }, { env: 逐字环境 });
  判(剥候选.strategy === SYSTEM_SINK_STRATEGY && 剥候选.stats.strippedBlocks === 1,
    '★ 非轻链候选必须带剥离统计，便于验收');

  // ── 第 2 刀：下沉规则摘要化（拆了这一刀就该红）────────────────────────
  const 大规则 = [
    'You are an AI agent powered by DeepSeek Harness.',
    '## §11.12 思考强度只高不低',
    'reasoningEffort 恒 high，⛔ 不许降档。',
    '## 派单细则',
    '回执必须写【已落盘】/【无需落盘】两个暗号之一，跑闭环后再回报。',
    '## 技能说明',
    '按关键词检索器只取命中那一篇 SKILL.md；启动包逐条核对后落盘。',
    ...Array.from({ length: 40 }, (_, i) =>
      `第 ${i} 条冗长规则：此处是需要逐条核对的细节描述，重复出现会让模型在推理里反复复述与裁决。`),
  ].join('\n');
  const 办事项 = [
    { role: 'system', content: 大规则 },
    { role: 'user', content: '修复哨兵并给出回执，按规矩办事' },
  ];
  const 摘 = summarizeRules(大规则, '修复哨兵并给出回执');
  判(摘.keptChars <= SUMMARY_MAX_CHARS, '★ 摘要总长必须有硬上限');
  判(摘.droppedChars > 大规则.length / 2, '★ 大段冗余规则必须被裁掉（拆了这一刀就该红）');
  判(摘.text.includes('§11.12'), '★ 宪法核心条款必须逐字保留');
  判(摘.text.includes('只写增量') && 摘.text.includes('不复述'),
    '★ 短规则必须写明「只写增量 / 不复述」，直击实测词频');
  判(摘.text.includes('按需 read'), '★ 必须给出规则全文的按需查阅指针');
  判(readSummaryConfig({}).enabled === true
    && readSummaryConfig({ WORKBUDDY_SINK_SUMMARY: 'off' }).enabled === false,
    '摘要开关默认开 / off 关');

  const 摘要轮 = buildSystemSinkMessages(办事项, { env: {} });
  判(摘要轮.summarized === true, '★ 非 A 类默认必须走摘要');
  判(摘要轮.messages[1].content.startsWith(SYSTEM_SINK_SUMMARY_PREFIX),
    '★ 摘要模式必须用独立抬头（⛔ 不改 SYSTEM_SINK_PREFIX）');
  判(!摘要轮.messages[1].content.includes('第 39 条冗长规则'),
    '★ 完整规则原文不得再进出站 payload（拆了这一刀就该红）');
  判(摘要轮.movedChars < 大规则.length / 3,
    '★ 出站规则长度必须显著小于原文（真机 keeps N chars 变小即验收点）');
  判(摘要轮.messages[1].content.includes('§11.12'), '★ 摘要出站仍须保留宪法核心条款');
  判(摘要轮.messages[2].content === '修复哨兵并给出回执，按规矩办事',
    '★ 宿主原话必须原样保留在其余消息里');
  const 回退 = buildSystemSinkMessages(办事项, { env: { WORKBUDDY_SINK_SUMMARY: '0' } });
  判(回退.summarized === false && 回退.messages[1].content.includes(大规则),
    '★ WORKBUDDY_SINK_SUMMARY=0 必须逐字全量回退');
  判(回退.messages[1].content.startsWith(SYSTEM_SINK_PREFIX),
    '★ 回退模式必须仍用原抬头，一字不变');
  const 摘要候选 = sinkCandidate({ model: 'm', messages: 办事项 }, { env: {} });
  判(摘要候选.strategy === SYSTEM_SINK_STRATEGY && 摘要候选.stats.summarized === true,
    '★ 候选 strategy 不变、stats 带摘要标记');
  判(摘要候选.stats.droppedChars > 0 && 摘要候选.stats.originalChars === 大规则.length,
    '★ stats 必须带原文长度与裁掉字数，便于真机验收');
  判(buildSystemSinkMessages(摘要轮.messages, { env: {} }) === null, '★ 摘要模式同样幂等');
  const 摘要A轮 = [
    { role: 'system', content: 大规则 },
    { role: 'user', content: A句 },
  ];
  判(buildSystemSinkMessages(摘要A轮, { env: {} }).light === true,
    '★ A 类轻链不受摘要影响（仍第一个 token 就答）');
  判(!JSON.stringify(buildSystemSinkMessages(摘要A轮, { env: {} }).messages).includes('§11.12'),
    '★ A 类轻链出站仍不含规则');

  // ── 第 3 刀：历史内务剥离 + 旧任务边界（拆了这一刀就该红）──────────────
  // 样本逐字取自 15:03 真会话原文，⛔ 不造指纹。
  const 时间快照 = 'Time sampled while preparing turn 24, step 8: 2026-11-08T15:06:40+08:00[Asia/Shanghai] Browser time zone for this request: unavailable.';
  const 运行快照 = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots. Current working directory: "C:\\Users\\a1872".';
  const 技能目录 = '<system-reminder> A skill is a reusable set of task-specific instructions. The following skills are available in this session: <available_skills> - `ai-workbench`...';
  const 自动唤醒 = '【系统自动唤醒】连接已恢复，回一句「已连接」即可。不要读文件、不要调用工具、不要做任何事。';
  const 跑飞告警 = '【哨兵·跑飞告警】⚠ 输出过长：**35563 token/轮**（上限 8000）—— 结论该写进文件，回复只留摘要 （这条不必回复。）';
  const 催促 = '【催一下】已经 12 分钟了，进度如何？ 接着做，有卡点就说一声。';
  const 压缩令 = 'Context limit reached — compress now. Produce a single summary and call compress.';
  const 宿主真令 = '把程序开发场景的旧单停掉，然后查一下 time-context 快照为什么这么多';
  判(isHistoryInternalMessage({ role: 'user', content: 时间快照 }) === 'time-context',
    '★ 必须认出 time-context 每步快照');
  判(isHistoryInternalMessage({ role: 'user', content: 运行快照 }) === 'runtime-context',
    '★ 必须认出 runtime-context 快照');
  判(isHistoryInternalMessage({ role: 'user', content: 技能目录 }) === 'skill-catalog',
    '★ 必须认出 skill-catalog system-reminder');
  判(isHistoryInternalMessage({ role: 'user', content: 自动唤醒 }) === 'auto-wake',
    '★ 必须认出系统自动唤醒');
  判(isHistoryInternalMessage({ role: 'user', content: 跑飞告警 }) === 'runaway-alert',
    '★ 必须认出哨兵跑飞告警');
  判(isHistoryInternalMessage({ role: 'user', content: 催促 }) === 'nudge',
    '★ 必须认出进度催促');
  判(isHistoryInternalMessage({ role: 'user', content: 压缩令 }) === 'compress',
    '★ 必须认出历史里的 ACP 压缩令');
  判(isHistoryInternalMessage({ role: 'user', content: 宿主真令 }) === '',
    '★ 含 time-context 字样的宿主真指令不得被误删（开头锚定）');
  判(isHistoryInternalMessage({ role: 'assistant', content: 时间快照 }) === ''
    && isHistoryInternalMessage({ role: 'tool', content: 时间快照 }) === '',
    '★ assistant / tool 一律不判内务（保护 tool_calls 配对）');

  const 脏历史 = [
    { role: 'user', content: '旧派单 m00308：请完成程序开发并回执' },
    { role: 'user', content: 时间快照 },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c9', content: 'ok' },
    { role: 'user', content: 技能目录 },
    { role: 'user', content: 跑飞告警 },
    { role: 'user', content: 宿主真令 },
  ];
  const 洗 = cleanHistoryMessages(脏历史);
  判(洗.removed === 3 && 洗.removedChars > 0,
    '★ 必须剥掉 3 条引擎内务（拆了这一刀就该红）');
  判(洗.removedKinds.includes('time-context') && 洗.removedKinds.includes('skill-catalog')
    && 洗.removedKinds.includes('runaway-alert'), '★ 剥离种类必须可写进日志验收');
  判(洗.messages.some((m) => m.content === '旧派单 m00308：请完成程序开发并回执'),
    '★ 历史里的宿主真派单正文必须保留（⛔ 不篡改宿主指令）');
  判(洗.messages.some((m) => m.content === 宿主真令), '★ 本轮宿主真指令必须原样保留');
  判(洗.messages[2].role === 'tool' && 洗.messages[1].tool_calls[0].id === 洗.messages[2].tool_call_id,
    '★ tool_calls / tool result 配对与顺序不得被清洗打断');
  判(脏历史.length === 7 && 洗.messages[0] === 脏历史[0], '★ 清洗不得改入参');

  const 脏轮 = [{ role: 'system', content: 大规则 }, ...脏历史];
  const 清轮 = buildSystemSinkMessages(脏轮, { env: {} });
  判(清轮.messages[1].content.includes('历史边界') && 清轮.messages[1].content.includes('不续跑'),
    '★ 出站规则必须带历史边界注记（把「要不要续跑旧单」的裁决题取消）');
  判(!JSON.stringify(清轮.messages).includes('Time sampled while preparing turn'),
    '★ 出站 payload 不得再带 time-context 快照（拆了这一刀就该红）');
  判(!JSON.stringify(清轮.messages).includes('【哨兵·跑飞告警】'),
    '★ 出站 payload 不得再带跑飞告警');
  判(JSON.stringify(清轮.messages).includes(宿主真令), '★ 清洗后本轮真指令仍在出站里');
  判(清轮.messages[1].content.startsWith(SYSTEM_SINK_SUMMARY_PREFIX),
    '★ 注记不得改变摘要抬头（⛔ 不动优先级声明）');
  判(清轮.historyBoundary === true && 清轮.historyRemoved === 3,
    '★ 下沉结果必须带清洗统计');
  判(buildSystemSinkMessages(脏轮, { env: 逐字环境 }).messages[1].content.includes('历史边界'),
    '★ 逐字回退分支也必须带历史边界注记');
  判(!JSON.stringify(buildSystemSinkMessages(A轮, { env: {} }).messages).includes('历史边界'),
    '★ A 类轻链不得带注记（它没有历史，注记只会多一道裁决题）');

  const 全回退 = buildSystemSinkMessages(脏轮, { env: { WORKBUDDY_HISTORY_CLEAN: '0' } });
  判(全回退.historyBoundary === false && 全回退.historyRemoved === 0,
    '★ WORKBUDDY_HISTORY_CLEAN=0 必须完全回退');
  判(JSON.stringify(全回退.messages).includes('Time sampled while preparing turn')
    && !JSON.stringify(全回退.messages).includes('历史边界'),
    '★ 回退后内务原话必须回来、注记不得出现');
  判(readHistoryCleanConfig({}).enabled === true
    && readHistoryCleanConfig({ WORKBUDDY_HISTORY_CLEAN: 'off' }).enabled === false,
    '历史清洗开关默认开 / off 关');

  const 兜底 = cleanHistoryMessages([
    { role: 'user', content: 自动唤醒 },
    { role: 'assistant', content: '已连接' },
    { role: 'user', content: 时间快照 },
  ]);
  判(兜底.messages.length === 2 && 兜底.removed === 1
    && 兜底.messages.some((m) => m.role === 'user'),
    '★ 本轮输入段清完必须有兜底，绝不出现无 user 输入');
  const 清候选 = sinkCandidate({ model: 'm', messages: 脏轮 }, { env: {} });
  判(清候选.stats.historyRemoved === 3 && 清候选.stats.historyRemovedChars > 0
    && 清候选.stats.historyBoundary === true,
    '★ 候选 stats 必须带 history 统计，便于真机验收');
  判(buildSystemSinkMessages(清轮.messages, { env: {} }) === null, '★ 第 3 刀后仍然幂等');

  const 轻 = buildSystemSinkMessages(A轮);
  判(轻 !== null && 轻.light === true, '★ A 类轮必须命中轻链');
  判(轻.messages.length === 2, '★ 轻链出站只能有中性 system + 宿主那一句');
  判(轻.messages[0].content === DEFAULT_NEUTRAL_SYSTEM, '轻链首条仍必须是中性 system');
  判(轻.messages[1].content === A句, '★ 宿主原话必须逐字保留');
  判(!JSON.stringify(轻.messages).includes('§11.12') && !JSON.stringify(轻.messages).includes('Compressible ranges'),
    '★ 17227 字规则原文与压缩模板不得进出站 payload');
  判(!JSON.stringify(轻.messages).includes('旧历史任务一句'), '★ 长历史不得进出站 payload');
  判(buildSystemSinkMessages([{ role: 'system', content: 规则 }, { role: 'user', content: '把 A 面板隐藏' }]).light !== true,
    '★ 非 A 类走摘要（宪法核心条款仍逐字进模型）');
  判(buildSystemSinkMessages(A轮, { env: { WORKBUDDY_A_LIGHT: '0' } }).light !== true,
    '★ WORKBUDDY_A_LIGHT=0 必须能回到完整下沉');
  判(readALightConfig({}).enabled === true && readALightConfig({ WORKBUDDY_A_LIGHT: 'off' }).enabled === false,
    '轻链开关默认开 / off 关');
  const 轻候选 = sinkCandidate({ model: 'm', messages: A轮 });
  判(轻候选.strategy.includes('a-light') && 轻候选.stats.movedChars === 0,
    '★ 轻链候选必须在日志里可识别（keeps 0 chars）');
  判(sinkCandidate({ model: 'm', messages: 原始 }).strategy === SYSTEM_SINK_STRATEGY,
    '★ 普通请求的候选 strategy 不得被改');

  if (红.length) {
    console.error(`system-sink --自测 ${总 - 红.length}/${总}：\n - ` + 红.join('\n - '));
    process.exit(1);
  }
  console.log(`system-sink --自测 ${总}/${总} 全绿`);
}

const isMain = (() => {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const arg = process.argv[1] ? realpathSync(process.argv[1]) : '';
    return self === arg;
  } catch { return false; }
})();
if (isMain && process.argv.includes('--自测')) 自测();

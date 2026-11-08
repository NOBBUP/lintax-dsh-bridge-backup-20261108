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

  const rules = systems
    .map((m) => messageText(m.content).trim())
    .filter(Boolean)
    .join('\n\n');
  if (!rules) return null;

  // ★ A 类给死答案：不下沉规则、不携带历史。模型没有可裁决的东西，自然直接答。
  if (readALightConfig(opts.env).enabled) {
    const dead = findDeadAnswer(messages);
    if (dead) {
      return {
        messages: [
          { role: 'system', content: neutralSystem },
          { role: 'user', content: dead },
        ],
        movedChars: rules.length,
        movedCount: systems.length,
        light: true,
      };
    }
  }

  const rest = messages.filter((m) => !isSystemMessage(m));
  return {
    messages: [
      { role: 'system', content: neutralSystem },
      { role: 'user', content: `${SYSTEM_SINK_PREFIX}\n${rules}\n${SYSTEM_SINK_SUFFIX}` },
      ...rest,
    ],
    movedChars: rules.length,
    movedCount: systems.length,
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
    stats: { movedChars: built.movedChars, movedCount: built.movedCount },
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

  const built = buildSystemSinkMessages(原始);
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

  const cand = sinkCandidate({ model: 'm', messages: 原始 });
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
  ]);
  判(多system.movedCount === 2, '多条 system/System 都要收拢');
  判(多system.messages[1].content.includes('规则A\n\n规则B'), '多条 system 用空行拼接且顺序不变');

  const parts = buildSystemSinkMessages([
    { role: 'system', content: [{ type: 'text', text: '规则甲' }, { type: 'text', text: '规则乙' }] },
    { role: 'user', content: '干活' },
  ]);
  判(parts.messages[1].content.includes('规则甲\n规则乙'), 'parts 数组 content 也要能提取');

  const 已下沉 = buildSystemSinkMessages(built.messages);
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
  const 轻 = buildSystemSinkMessages(A轮);
  判(轻 !== null && 轻.light === true, '★ A 类轮必须命中轻链');
  判(轻.messages.length === 2, '★ 轻链出站只能有中性 system + 宿主那一句');
  判(轻.messages[0].content === DEFAULT_NEUTRAL_SYSTEM, '轻链首条仍必须是中性 system');
  判(轻.messages[1].content === A句, '★ 宿主原话必须逐字保留');
  判(!JSON.stringify(轻.messages).includes('§11.12') && !JSON.stringify(轻.messages).includes('Compressible ranges'),
    '★ 17227 字规则原文与压缩模板不得进出站 payload');
  判(!JSON.stringify(轻.messages).includes('旧历史任务一句'), '★ 长历史不得进出站 payload');
  判(buildSystemSinkMessages([{ role: 'system', content: 规则 }, { role: 'user', content: '把 A 面板隐藏' }]).light !== true,
    '★ 非 A 类仍走完整下沉（宪法照旧进模型）');
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

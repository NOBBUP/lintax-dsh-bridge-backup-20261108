#!/usr/bin/env node
/**
 * 派单.mjs —— 跨场景派单的「真投递」那一半
 *
 * 为什么要它：
 *   上游 `工具\发消息.mjs` 负责**落盘**（看板 + 目标场景记忆的一行），
 *   但它自己就写明了「⚠ 派单已落盘，但**还没有唤醒目标会话**」——
 *   因为落盘 ≠ 送达。宿主 2026-11-01 实测：11 个场景 0 回执，
 *   根因就是面板 401 白屏 ⇒ 派单物理上送不进去。
 *
 *   本工具补的就是这一半：把派单正文**真的发进目标场景的会话**，
 *   走引擎 RPC `session/prompt`（= 一个用户回合），对方会话会真的被唤醒。
 *
 * 用法：
 *   node 工具\派单.mjs --to <场景id或场景名> --正文文件 "工作区\_派单.txt" [--干跑]   ← ★推荐
 *   node 工具\派单.mjs --to <场景id或场景名> --正文 "…" [--干跑]
 *   node 工具\派单.mjs --检查          # 只体检通道，不派单
 *
 * ⚠ 长正文/含引号含反斜杠的正文，一律用 `--正文文件`（UTF-8 写的 .txt）。
 *   PowerShell 会把双引号里的 `\` `"` 和结尾的 `--干跑` 一起吞掉，实测真踩（见下）。
 *
 * 上游依据（不是自创机制）：
 *   00-核心机制\四-派单机制.md §1「② 投递（必须真唤醒）」
 *   00-核心机制\一-协作机制.md §4「发完看回执：投递成功的标志是对方那边**真的接受了**」
 *   L0 宪法 §6「派单 ≠ 公告」「通道不通不派单」
 *
 * 硬规矩（照上游原文）：
 *   1. 派单必须真投递；投递不进去 ⇒ 停下并报错，**不许假装发了**。
 *   2. 同一件事 ≤ 3 条消息；末行写【结束】。
 *   3. 回执四件套：结论 + 证据 + 落盘路径 + 还差什么。
 */
import fs from 'node:fs';
import { 帧文本 } from './_共用-会话解码.mjs';   // ★ 会话解码单一真源
import path from 'node:path';
import zlib from 'node:zlib';                     // ★ 三期·观察模式要解多帧 zstd
import { fileURLToPath } from 'node:url';
import { 剥运行时内务 } from './_共用-剥运行时内务.mjs';  // ★ 15:2x 单一真源：与广播派单共用同一份词表
import { 结构化正文 } from './_共用-派单结构化.mjs';       // ★ §11.35 单一真源：答题链/治理链分离，两个出口共用

const IS_MAIN = (() => {
  try {
    const a = String(process.argv[1] || '');
    if (!a) return false;
    const rp = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    return rp(a).toLowerCase() === rp(fileURLToPath(import.meta.url)).toLowerCase();
  } catch { return false; }
})();

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
const DSH_PORT = String(process.env.DSH_PORT || '3083');
const DSH_HOME = process.env.DSH_HOME || path.join(ROOT, '引擎', '.dsh');

const argv = process.argv.slice(2);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : ''; };
const has = (k) => argv.includes(k);
/** 取可重复参数的所有值：--允许 a --允许 b */
const vals = (k) => { const o = []; for (let i = 0; i < argv.length; i++) if (argv[i] === k && argv[i + 1]) o.push(argv[i + 1]); return o; };
const 干跑 = has('--干跑');
const 目标 = val('--to');

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-02 二期·**授权范围 Mandate** ★★★
//
//   要解决的真问题（不是"再加一个字段"）：
//     16:25 GUI页面改造 的回执里自己写着「顺手修了两个通道 bug」——
//     它改了 `工具\发消息.mjs` 和 `工具\回执检查.mjs`，**那不是它的活**。
//     但当时没有任何东西拦它：派单正文没写"你能动哪些文件"，
//     查回执时也没人问"你动的文件在不在授权范围内"。
//     ⇒ 越权修改在台账上照样显示 ✅ 已交。
//
//   ⇒ 现在每张单自带 `mandate`：允许动哪些路径、禁止动哪些、验收条件是什么。
//     派单时自动按**场景职责**填默认值（下面 SCENE_SCOPE），也可命令行覆盖。
//     回执核账时（查回执台账.mjs）拿它逐条比对"落盘"路径 —— 越权直接判 越权，
//     ⛔ 绝不再显示"已交"。
//
//   ⚠ 判据写法：路径**前缀**比较（关系判据），不是"文本里出现某词"。
//     denyPaths 优先级高于 allowPaths（先禁后允），且精确到文件也支持。
//   ⚠ `_原始包备份\` 是全局豁免：改动前必须先备份，备份本身不算越权。
// ══════════════════════════════════════════════════════════════════════════
const GLOBAL_ALLOW = ['_原始包备份\\'];      // 谁都允许往这写（备份目录）
const SCENE_SCOPE = {
  'code-dev': {
    // ⚠⚠ 2026-11-03 19:58 清理**失效授权项**（实测出来的，不是拍脑袋）：
    //   · `D:\项目\` —— 这个目录**现在完全是空的**（真数据已迁到 `D:\Lintax数据\项目\`）
    //     ⇒ 留着它，回执写 `D:\Lintax数据\项目\命令\…` 会被判「不在授权范围内」⇒ **假越权**
    //     （11-02 那 7 单程序开发的老单，全是这样被误判的）
    //   · `.lintax-tmp\` —— 工作台根下确实有，但真实产物落在 `D:\Lintax数据\_tmp\`（279 项）
    //     ⇒ 两个都留着（哪个是真身由文件系统判，不猜）
    allowPaths: ['工具\\', 'D:\\Lintax数据\\项目\\', '.lintax-tmp\\', 'D:\\Lintax数据\\_tmp\\', 'L2场景私有\\程序开发\\'],
    denyPaths: [],
    验收: ['node --check 改过的每个文件 exit=0', '自测/验收脚本 exit=0，且正反样本都打过'],
  },
  'dsh-gui': {
    // 工作台改造：本体的外壳与引擎归它，**工具脚本不归它**（那是程序开发/命令的地盘）
    allowPaths: ['外壳\\', '引擎\\', 'L2场景私有\\工作台改造\\', 'L2场景私有\\GUI页面改造\\', 'L2场景私有\\DSH改造\\',
      // ⚠ 2026-11-03 补（真被误判过）：L0 宪法 §10 要求每个场景**自己**写 `项目信息\NN_主题.md`，
      //   但这里原来只给了 `L2场景私有\…\`，没给 `D:\Lintax数据\项目\工作台改造\` ⇒
      //   工作台改造 13:54 那单老老实实按宪法写了 09_场景改名后的定位卡与换会话硬伤.md，
      //   反被台账判「⛔ 越权」。**让场景遵守宪法，却把遵守宪法的产物判成越权**，这是工具的病。
      'D:\\Lintax数据\\项目\\工作台改造\\', 'D:\\Lintax数据\\项目\\GUI页面改造\\', 'D:\\Lintax数据\\项目\\DSH改造\\'],
    denyPaths: ['工具\\'],
    验收: ['改完的文件 node --check exit=0', '真实面板自检/探针数据落盘', 'main.js/preload.js 改动只能报告，不许自行重启'],
  },
  'command': {
    allowPaths: ['工具\\', 'L1共享层\\', 'L2场景私有\\命令\\', 'D:\\Lintax数据\\项目\\命令\\'],
    denyPaths: [],
    验收: ['工具改动 node --check exit=0', '判据要有正反样本'],
  },
  'pc-cleanup': { allowPaths: ['L2场景私有\\本地电脑\\', 'D:\\Lintax数据\\'], denyPaths: [], 验收: [] },
  // ★ 2026-11-03 13:50 宿主定：`客户系统运维` 改名 **`公司网站运维`**，场景 id `oa-ops` 不动。
  //   职责扩成「运维公司各个网站 + 把网站做成成熟产品」；一个网站 = 一个项目 = 一条会话 = 一份 `项目信息\`。
  //   ⚠ 记忆目录跟着改名（L2场景私有\公司网站运维\）⇒ 这里的 allowPaths 不同步就会把正常回执判「越权」。
  'oa-ops': { allowPaths: ['L2场景私有\\公司网站运维\\', 'D:\\Lintax数据\\项目\\公司网站运维\\'], denyPaths: [], 验收: [] },
  // ★ 2026-11-03 新增场景 `AI工作台`（id `ai-workbench`）：AI 工作台网站（Cloudflare Pages）
  //   的指令门 / 对话接口 / 模型清单 / 部署与迭代。一个网站项目 = 一条独立会话 = 一份项目信息。
  'ai-workbench': { allowPaths: ['D:\\Lintax数据\\项目\\AI工作台\\', 'L2场景私有\\AI工作台\\'], denyPaths: [], 验收: [] },
  'personal-site': { allowPaths: ['D:\\Lintax数据\\项目\\', 'L2场景私有\\个人站点\\'], denyPaths: [], 验收: [] },
  'blender': { allowPaths: ['D:\\Lintax数据\\项目\\', 'L2场景私有\\三维建模\\'], denyPaths: [], 验收: [] },
  'video-workflow': { allowPaths: ['D:\\Lintax数据\\项目\\', 'L2场景私有\\视频工作流\\'], denyPaths: [], 验收: [] },
  'self-review': { allowPaths: ['自我复盘\\', 'L2场景私有\\自我复盘\\'], denyPaths: [], 验收: [] },
  'design-misc': {
    // ⚠ 2026-11-04 补（实测误判）：宿主 18:19 直接下令「下载安装 billion-contest 插件，派发给设计杂活」，
    //   它按官方装法写进 `引擎\.dsh\profiles\web\package.json` + `node_modules\billion-context`，
    //   结果被台账判「⛔ 越权」—— **让它装插件，却没给它装插件的地方**。这条是工具的病（坑㊵族）。
    //   ⚠ 2026-11-05 07:25 收窄（第十四次巡检，m00180 长期欠账）：原「永久放开 profiles\web\」
    //   是「装一次插件」留下的全局授权，等于把引擎配置目录长期给了设计杂活（污染路径 #1）。
    //   现改为默认不给；将来真要装插件，用 --允许 逐单显式授权（命令行覆盖已支持，不是砍需求）；
    //   ⛔ 不写死行号（坑㉗：编号会随插入/删行漂移，死链比没注释更坏）。
    //   ⛔ 仍不放开整个 引擎\（那是工作台改造的地盘）。
    allowPaths: ['L2场景私有\\设计杂活\\', 'D:\\Lintax数据\\项目\\设计杂活\\'],
    denyPaths: ['引擎\\.dsh\\skills\\'],
    验收: [] },
  'bilibili': { allowPaths: ['L2场景私有\\B站\\'], denyPaths: [], 验收: [] },
};

/** 按场景 id 生成默认 mandate（未知场景 ⇒ 只允许自己记忆目录，宁可严） */
function defaultMandate(sceneId, sceneName) {
  const s = SCENE_SCOPE[sceneId];
  if (s) return { allowPaths: [...s.allowPaths], denyPaths: [...s.denyPaths], 验收: [...s.验收] };
  return { allowPaths: ['L2场景私有\\' + (sceneName || sceneId) + '\\'], denyPaths: [], 验收: [] };
}

// ══════════════════════════════════════════════════════════════════════════════════
// ★★ 2026-11-03 加（宿主：「这个是不是归程序开发场景管呢？」逼出来的）★★
//
//   **病根**：`SCENE_SCOPE` 里 `工具\` 是一整个目录，同时开给了 `code-dev` 和 `command`
//   ⇒ 同一个目录两个场景都能写，边界糊成一团。真发生过的伤：
//     · 我把 派单.mjs / 查回执台账.mjs 改完，程序开发那边也在改同批文件
//     · 事后只能靠 `_跨场景通知.md` 里"谁在落盘段里认领过"去倒推归属
//
//   **但不能一刀切按目录分给谁**——历史数据证明同一批工具被多个场景改过：
//     `发消息.mjs` 被 `GUI页面改造` 和 `程序开发` 都动过；
//     `项目本地化体检.mjs` 被 5 个场景提到、被 程序开发 改过。
//   ⇒ 硬切会把**正常的协作**判成越权（冤枉比漏报贵）。
//
//   **做法**：建一张**工具归属表**，只做两件事：
//     ① 派单时把「这批工具归谁」写进正文（让对方知道自己动的是谁的东西）
//     ② 台账核对时，发现"别人改了我的工具"就**打一条提醒**（不是越权，是提醒该知会一声）
//   ⛔ 不做硬拦。这张表的用途是**让边界可见**，不是造一堵墙。
// ══════════════════════════════════════════════════════════════════════════════════
/**
 * 台账 `head` 取哪一行 —— **本单的实质内容，不是模板壳**。
 *
 * ★ 2026-11-06 01:0x（坑72，我自己踩出来的）：原来取「正文第一条非空行」，
 *   而 `_共用-派单结构化.mjs` 之后正文第一行永远是模板套话：
 *     `【本单指令】按正文第一句做；⛔ 本次没标「原话：」，别把上游推测当新指令。`
 *   实测 157 行台账里 **8 行** head 一模一样（自我复盘 / 工作台改造 ×4 / 命令 ×2 / 程序开发）。
 *   后果不是"不好看"，是**判据失效**：`查回执台账.mjs` 的 `contentScore(单.head, 回执.body)`
 *   与 `identityOk()` 都靠 head 认人，head 全同 ⇒ 只能按时间就近硬配 ⇒ 同会话两单必有一单空手。
 *   实测：00:28:52 与 00:29:03 两行（同会话、同 mandate、同 head）里前者永远等不到回执。
 * ⇒ 关系式修法：取**第一条不是套话的行**；整篇只有套话时才退回第一行（宁可难认，不许编）。
 */
export function ledgerHead(body) {
  // ⛔ 只丢「换个单子也不会变的壳」，⛔ 不许把 `【本单唯一指令】<宿主原话>` 当壳丢掉 ——
  //   那一行恰恰是这一单唯一的实质内容（23:13:44 / 23:44:37 / 00:33:25 等 5 行就是这种）。
  const SHELL = [
    /^【本单指令】按正文第一句做/,            // 没标原话时的固定占位句，内容为零
    /^〔上游背景·只读〕/,                     // 背景段头，固定
    /^⛔ 只做这一句；下面是背景与工具口径/,     // 固定
    /^■ 交付（只跑这一条）/,                  // 固定交付口径
    /^■ 授权范围：/,                          // 固定授权段
    /^■ 回执/,                               // 旧版固定回执段
    /^…（背景/,                             // 截断标记
    // ★ 2026-11-06 07:2x（坑74，值守轮实测）：**带序号的段标题也是壳**。
    //   事故：05:52 那张重派单，结构化之后第 0 行是占位套话、第 1 行是 `## 四、⛔ 硬要求`
    //   ⇒ head 落成「## 四、⛔ 硬要求」，等于没头。后果不是不好看：台账认不出这一单，
    //   它 06:29 交了完整回执，却被判「未回执 + 逾期」。
    //   ⛔ **只跳「带序号」的段标题**（`## 四、硬要求` / `## 一、我已收到的` 这种：序号说明
    //      「这是第几段」，描述的是结构）。**不跳不带宽号的标题**——`# 派单 · 工作台改造 ·
    //      引擎自动注入缺口…` 这种标题**就是这一单的主题**，是内容，跳了等于把单子弄成没头。
    //      （我第一版写成 `/^#{1,6}\s/`，回填时把 11-03 六张真有主题的老单全变成正文首句，
    //       台账从 112,434 → 112,782 B 立刻看出来 —— 已还原重做。）
    /^#{1,6}\s*(?:[一二三四五六七八九十百]+|\d+)\s*[、.,．)]/,   // 带序号的段标题 = 结构
  ];
  // ⛔ 先剥掉投递前缀 `【派单】` —— 不剥的话下面每条壳行都差一个前缀，一条也认不出（实测）。
  const ls = String(body || '').replace(/^\s*【派单】/, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = ls.find((l) => !SHELL.some((re) => re.test(l))) || ls[0] || '';
  return pick.slice(0, 120);
}

/**
 * 正文自己有没有**已经指定回执通道**？
 *
 * ★ 2026-11-06 11:2x（值守轮实测抓到的真事故）：
 *   09:27 那张「调度测试」正文里明明白白写着
 *     「1. 收到立刻回：`node 工具\发消息.mjs --to 命令 --回执 "【<场景名>】收到"`」
 *     「2. 随后交四件套回执，末行【结束】，同样走发消息.mjs --回执」
 *   而 L78x 的注释一直写着「防重复：正文里已含 `发消息.mjs` 就不再注入」——
 *   **但代码从来没实现这一条**（只判 `■ 交付（只跑这一条）` / `■ 回执（闭环代发）`）。
 *   于是工具又在末尾追加了「■ 回执（闭环代发）…⛔ 不另跑发消息.mjs、不手写四件套」。
 *
 *   后果不是"啰嗦"，是**同一张单里两条互斥指令**：
 *     · 正文说：用 发消息.mjs --回执 交四件套；
 *     · 尾巴说：⛔ 不另跑发消息.mjs，只跑 闭环.mjs。
 *   实测后果（自我复盘 09:29 那单）：它先在推理里花力气裁决这两条哪条算数
 *   （会话流里原话：「There's a conflicting instruction within the dispatch itself.」），
 *   最后只在自己会话里回了「收到」两个字 ⇒ **看板 0 条 ⇒ 台账判未回执**。
 *   这正是宿主 20:36 骂的那种"一个回执要思考一小时"的结构性来源：
 *   **不是场景笨，是我给了它两条打架的指令，逼它先当法官。**
 *
 * ⇒ 判据（关系式，不问长相、问"这一单到底走哪条通道"）：
 *   正文里一旦出现**回执命令本身**（`发消息.mjs … --回执` 或 `闭环.mjs … --回执`），
 *   说明作者已经选定了通道 ⇒ 工具**不许**再注入第二套。
 *   注入的意义是"作者忘了写通道时兜底"，不是覆盖作者的明确指定。
 * ⚠ 只认「脚本名 + 同一行里带 `--回执`」这个组合 —— 光提脚本名不算
 *   （正文里说"别跑 发消息.mjs"、或"参考 闭环.mjs 的用法"都不该夺走注入）。
 * ⛔ 反样本必须仍能注入：普通正文（只描述业务、没写回执命令）⇒ 照旧追加回执行。
 */
export function 正文已带回执通道(body) {
  return /(?:发消息|闭环)\.mjs[^\n]{0,120}--回执/.test(String(body || ''));
}

/**
 * 台账 `headRaw` —— 「这一单是什么类型」的判据要看的那一行（结构标记行）。
 *
 * ★ 2026-11-06 01:4x（坑72 的连带，我自己踩的）：把 `head` 改成「实质内容行」之后，
 *   `查回执台账.mjs` 的 `classifyOrder()` 立刻判错 —— 它靠 head 认「应答型 / 握手 / 内务串」，
 *   而这些信号**恰恰在结构标记行上**（`【本单唯一指令】只回复收到…` / `【新会话 · 第N条】`）。
 *   实测：23:13:44 那单（只回「收到」）改完 head 后从「应答型」掉回「派单」⇒ 立刻变成未回执 + 逾期。
 * ⇒ 一个字段不许同时干两件事：
 *     `headRaw` = 结构标记行（判类型）   `head` = 实质内容行（判身份/内容分）。
 */
export function ledgerHeadRaw(body) {
  const ls = String(body || '').replace(/^\s*【派单】/, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (ls[0] || '').slice(0, 120);
}

export const TOOL_OWNER = {
  // ── 命令：派单 / 回执 / 消息通道（命令的天职，别人别碰）──
  '派单.mjs': 'command',
  '广播派单.mjs': 'command',
  '查回执台账.mjs': 'command',
  '回执检查.mjs': 'command',
  '回执速览.mjs': 'command',
  '快读回执.mjs': 'command',
  '_查回执.mjs': 'command',
  '发消息.mjs': 'command',
  '开工打点.mjs': 'command',
  // ── 命令：共享层 / 场景记忆 / 索引体检（单一真源的维护者）──
  '同步通用手册.mjs': 'command',
  '同步技能入口.mjs': 'command',
  '重建共享记忆索引.mjs': 'command',
  '项目本地化体检.mjs': 'command',
  '项目索引.mjs': 'command',
  '项目收尾闸.mjs': 'command',
  '生成场景身份索引.mjs': 'command',
  '场景记忆.mjs': 'command',
  '收工自检.mjs': 'command',
  '查记忆保全.mjs': 'command',
  '查失效路径.mjs': 'command',
  '查违规重启.mjs': 'command',
  '查体积误诊.mjs': 'command',   // 外部包按「磁盘体积」判爆内存 vs 工作台唯一口径 已用token/contextWindow
  '经验沉淀.mjs': 'command',
  '坑归档.mjs': 'command',
  '坑库瘦身.mjs': 'command',
  '宪法追加-项目本地化.mjs': 'command',
  '写定位卡.mjs': 'command',
  '修定位卡记忆路径.mjs': 'command',
  '补核心职责.mjs': 'command',
  '补交接.mjs': 'command',
  '恢复技能坑条目.mjs': 'command',
  '验证所有场景可fork.mjs': 'command',
  '闭环.mjs': 'command',
  // ── 程序开发：哨兵 / 压缩 / 交接机制（它的主战场）──
  '压缩我的会话.mjs': 'code-dev',
  '压缩前落盘.mjs': 'code-dev',
  '自动交接.mjs': 'code-dev',
  '交接.mjs': 'code-dev',
  '交接判定.mjs': 'code-dev',
  '交接死循环自测.mjs': 'code-dev',
  '交接故障注入测试.mjs': 'code-dev',
  '查交接一致性.mjs': 'code-dev',
  '申请交接.mjs': 'code-dev',
  '余量.mjs': 'code-dev',
  '会话水位.mjs': 'code-dev',
  '导出会话提纲.mjs': 'code-dev',
  '网站改动自检.mjs': 'code-dev',
  // ★ 2026-11-07 21:1x 补登（19:29「恢复哨兵与自动换会话」单收尾，程序开发回执③点名由命令层做）：
  //   脚本真落盘后才登记，现在登记才不是幽灵条目；此前 `派单 --自测 ②` 判红 38/39，缺的正是这几支。
  //   归属已定：三支哨兵/急停按本段「哨兵/压缩/交接＝程序开发主战场」＋本单由程序开发从备份
  //   恢复并改造、回执 landedPaths 全在 工具\ 内未判越权 ⇒ code-dev；
  //   ⚠ 371-372 行旧注释「上下文急停归 command」是 11-05 命令层自建期口径，19:19 宿主改派
  //   程序开发后以本条为准。`查界面实显.mjs` 是只读判据，同 查注入可见/查交接新鲜/查会话真换
  //   一族 ⇒ command。只补登记，⛔ 不改判据、不改阈值、不改授权范围。
  '会话哨兵.mjs': 'code-dev',
  '哨兵守护.mjs': 'code-dev',
  '上下文急停.mjs': 'code-dev',
  '查界面实显.mjs': 'command',
  // ── 程序开发：会话/绑定/建站等基础设施 ──
  '绑定会话.mjs': 'code-dev',
  '换会话.mjs': 'code-dev',
  '唤醒会话.mjs': 'code-dev',
  'sessions.mjs': 'code-dev',
  '诊断面板.mjs': 'code-dev',
  'l6-沉淀.mjs': 'code-dev',
  '迁移到D盘.mjs': 'code-dev',
  '迁移剩余两项.mjs': 'code-dev',
  '发布前检查.mjs': 'code-dev',
  '打exe.mjs': 'code-dev',
  '封装.mjs': 'code-dev',
  '注册工作区.mjs': 'code-dev',
  '探RPC.mjs': 'code-dev',
  '替换占位符.mjs': 'code-dev',
  // ★ 2026-11-04 补登（上一轮做插件同步时**漏了登记**，这次一并补上）
  '插件同步.mjs': 'code-dev',
  '插件在用核查.mjs': 'code-dev',
  '插件清单.md': 'code-dev',   // 数据（单一真源），由 插件同步.mjs 生成
  // ★ 2026-11-05 补登（记忆层级单新增的两支脚本）
  '记忆层级体检.mjs': 'code-dev',
  '共享记忆写入闸.mjs': 'code-dev',
  // ★ 2026-11-05 补登（自测 ② 抓出来的真缺口：这两支早就在用，却一直没登记）
  '启动包.mjs': 'command',
  '场景职责表.mjs': 'command',   // 数据（12 场景唯一真源），被启动包/插件同步/记忆体检共同 import
  // ★ 2026-11-05 补登（零件库 / 改造后体检 也是本场景新产物；改造后体检由命令侧自建但要归口）
  '零件库.mjs': 'code-dev',
  '改造后体检.mjs': 'command',   // 命令侧 00:44 自建（撤回误派），程序开发只读不改
  '派单分流.mjs': 'command',   // 命令侧 00:45 自建
  // ★ 2026-11-03 补登（第一版漏了这几个正式脚本）
  '会话交接.mjs': 'code-dev',
  '查刷新断连.mjs': 'code-dev',
  '瘦身场景记忆.mjs': 'command',
  '更新文档.mjs': 'command',
  // ⛔ 重启工具：宿主铁律「所有任务都不准重启」。物理已禁用（执行报 403），
  //    登记成 'forbidden' 是为了让 TOOL_OWNER 覆盖完整 —— **谁都别修它，谁修谁违规**。
  '一键重启工作台.mjs': 'forbidden',
  // ★ 2026-11-05 补登（命令侧 11:02 / 11:33 自建，② 判据先红了两条）：
  //   `每轮动作预算.mjs` 只读审计「每轮必做动作有几条」（⛔ 不挂进每轮链，只在 C 类审计手动跑）
  //   `上下文急停.mjs` 机制层硬闸（使用率≥100% 或 running 超时 ⇒ 压缩/换会话；⛔ 不向会话发消息）
  //   ⇒ 两个都是命令层自建的机制工具，归属 command。
  '每轮动作预算.mjs': 'command',
  // ★ 2026-11-05 20:1x 活循环判据（只治「一直动却烧掉一小时」，零进展型归上下文急停）
  // ★ 2026-11-05 20:3x 判「规则真进了会话」而不是「写在磁盘上」（引擎把 description 截到 ~523 字）
  '查注入可见.mjs': 'command',
  // ★ 2026-11-05 21:2x 判「换了会话，交接正文真写了吗」（§〇 必须在开篇投递前 5 分钟内更新过）
  '查交接新鲜.mjs': 'command',
  // ★ 2026-11-05 14:2x 补登（另一个命令会话 13:2x~14:2x 自建的六个命令层机制工具，
  //   `派单 --自测 ②` 抓到「缺 6 个」）：全部只读判据 / 机制层，归属 command。
  '查坑沉淀.mjs': 'command',     // 坑从 §五 自动进场景技能，可判红
  '查推理档.mjs': 'command',     // 只读判据：思考强度只高不低（13:23 宿主裁决）
  '查每轮注入.mjs': 'command',   // 保证快路径真在引擎每轮唯一自动注入的位置
  '查索引命中.mjs': 'command',   // 按关键词搜索引、命中只读那一篇
  '端到端测速.mjs': 'command',   // 只读算 宿主发出→AI首响→本轮结束
  '防污染闸门.mjs': 'command',   // 闸门放入口，只读判据
  '查派单出口.mjs': 'command',   // 两个派单出口是否都挂了内务串剥离，共用同一真源
  // ★ 2026-11-08 21:2x 回档补齐（这五条 11-08 20:44:50 被另一命令会话误删后又恢复，
  //   登记行在磁盘上丢了 ⇒ `派单 --自测 ②` 判「缺 5 个」。按 11-06 备份原文原样补回，归属 command。
  //   教训：文件恢复了 ≠ 登记表恢复了，两张表要一起对。
  // ★ 2026-11-05 20:1x 活循环判据（只治「一直动却烧掉一小时」，零进展型归上下文急停）
  '查活循环.mjs': 'command',
  // ★ 2026-11-05 20:3x 判「规则真进了会话」而不是「写在磁盘上」（引擎把 description 截到 ~523 字）
  '查新坑.mjs': 'command',     // 堵「踩了坑一个字没写」盲区；机制上线后按会话原文 × §五 落盘判红
  // ★ 2026-11-06 01:0x（另一个命令会话 23:42 / 00:12 新建的命令层只读判据，补登记）
  '查内务重规划.mjs': 'command',   // 只读：内务提示被当宿主指令、重写一大段规划
  '查办事预算.mjs': 'command',     // 只读：一轮是否超宪法办事硬预算（≤8 工具 / reasoning ≤1 句）
  // ★ 2026-11-06 07:3x（另一个命令会话 01:33:55 新建的命令层改动刹车判据，补登记）
  '查重复动作.mjs': 'command',     // 只读：同一动作（命令名+归一化参数）一轮内重复 ≥3 次 ⇒ 停手重想
  // ★ 2026-11-05 18:5x 补登（另一个命令会话 16:2x~18:3x 自建的三个命令层判据，
  //   `派单 --自测 ②` 抓到「缺 3 个」）：全部只读判据，归属 command。
  '查会话真换.mjs': 'command',   // 「换了新会话」必须真落到磁盘绑定（scenarios json 回写），⛔ 界面变了不算
  '查口径单一.mjs': 'command',   // 「什么算一张真派单」只能有一份定义，两个调用方必须真委托
  // 2026-11-07 全量回档验收补登：只读「环境能力矩阵」脚本一直在磁盘上却漏登记，
  // ⇒ `派单 --自测 ②` 判「正式脚本全部已登记」红。只补登记，不改判据、不改阈值。
  '查环境能力.mjs': 'command',
};

/** 查一个工具文件归谁（只认 basename；查不到 ⇒ ''，表示"没登记"，不指控） */
/**
 * ★ 16:0x 互斥裁决：把「自行选概率更高的」从**模型判断**搬到**派单出口确定性收敛**。
 *   取证：15:44 单同时要求「不重启整个工作台」＋「main.js 主进程改动生效」，正文还明写
 *   「请判断这两条是否真的互斥」；模型 turn34 花 6 段 / 141,070 字 / 20+ 分钟反复重写
 *   「不重启」方案、无 turn/end。而正文自己已给出确定答案：GUI 进程起于 12:28，早于文件
 *   mtime ⇒ 跑的是启动时读进内存的旧码，soft 热更不碰主进程。
 *   ⛔ 为什么不能照字面叫模型「估概率」：POINTER 每轮必注入「⛔不裁决令／不重规划／
 *      禁但是重开已定X」，这单仍没执行；再加一层概率权衡＝又造一条与「不裁决令」互斥的
 *      指令，且注入位只剩 32 字（SKILL.md L1617 明令不许再堆）。历史 v1 抬头被逐字引用
 *      13 次 / turn21 净负，正是这类优先级裁决。
 *   ⇒ 只认**客观物理约束**的这一组互斥词对；命中即在正文追加一条「已判好的」执行路径，
 *      模型照做即可，不需要估概率、不需要再裁决两条是否互斥；不命中则一字不动。
 *   ⛔ 保守：不发明通用优先级规则，⛔ 不靠 main.js／落盘 等泛词误伤普通单；
 *      命中后追加的这句不含「末行【结束】」，避免与 回执行 的收尾并列打架。
 */
export function 互斥裁决(正文) {
  const s = String(正文 || '');
  const 不重启 = /不(?:自行)?重启|不重启整个工作台|勿重启|禁止重启|不准重启|不重启\s*GUI/i.test(s);
  const 需重启 = /重启(?:后)?才(?:能)?(?:加载|生效)|必须重启才|须宿主重启|改动须重启/i.test(s);
  if (不重启 && 需重启) {
    return '【互斥裁决·派单出口已判】本单同时出现「不重启」与「主进程改动须重启才生效」：磁盘改了但运行中的主进程不会重读，这一组里只有「改完代码 + 报告 + 等宿主重启/重载」物理上成立 ⇒ 直接回报卡在哪个进程、哪行常量/模块加载点、最小必要动作、宿主点一下之后可当场复跑的验收命令；⛔ 不再寻找不重启路径、不再重写方案、不再裁决两条是否互斥。';
  }
  return '';
}

export function toolOwner(filePath) {
  const s = String(filePath || '').replace(/\\/g, '/');
  if (!/^工具\//.test(s) && !/\/工具\//.test(s)) return '';
  const base = s.split('/').pop();
  return TOOL_OWNER[base] || '';
}

// ★ 2026-11-02 加：长正文一律写进 UTF-8 文件再 `--正文文件` 传。
//   原因（实测踩到，同 坑⑧）：PowerShell 双引号里 `\` 和 `"` 会被吃掉，
//   `--正文 "...\"...\" --干跑"` 会被消成一句话，`--干跑` 变成正文的一部分
//   ⇒ has('--干跑')=false ⇒ **干跑变成了真发**（17:49:15 真发出去一条残句）。
//   判据：干跑必须打印「（--干跑：没真的发）」且台账**不新增行**。
const 正文文件 = val('--正文文件');
const 读正文文件 = (p) => {
  const cands = path.isAbsolute(p) ? [p] : [path.resolve(ROOT, p), path.resolve(p)];
  for (const c of cands) if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  die('找不到正文文件：' + p);
};
const 正文 = 正文文件 ? 读正文文件(正文文件) : val('--正文');

const die = (s) => { console.error('✗ ' + s); process.exit(1); };

// ── 场景表：id → {name, 会话名, 会话id} ──────────────────────────────
// 会话 id 从场景 json 的 harness 面板里读（pinTarget / sessionId），
// 读不到就报「没绑定会话」，**不猜**。
function loadScenes() {
  const out = new Map();
  if (!fs.existsSync(SCEN)) return out;
  for (const f of fs.readdirSync(SCEN).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8')); } catch { continue; }
    if (!j || !j.id) continue;
    const panels = (j.panels || []).filter((p) => p && p.type === 'harness');
    out.set(j.id, {
      id: j.id,
      name: j.name || j.id,
      panels: panels.map((p) => ({
        id: p.id,
        title: p.title || p.id,
        sessionId: p.sessionId || '',
        sessionTitle: p.sessionTitle || '',
      })),
    });
  }
  return out;
}

// ── 场景改名对照（2026-11-03 13:50 宿主定）─────────────────────────────
// 旧名 → 新名。**只做"别名转正名"，不新建场景**：id 永远不因改名而变。
//   · `客户系统运维` → `公司网站运维`（id 仍 `oa-ops`）
//   ⚠ 为什么必须有这张表：台账里 2026-11-03 13:50 之前的历史单、历史回执、历史记忆
//     全写着旧名；没有别名表，`--to 客户系统运维` 会直接「找不到场景」，
//     而 `查回执台账.mjs` 也会把旧单判成"场景不存在"。
//   ⛔ 别名表只许写「确实改过名」的，不许拿它当万能模糊匹配。
const SCENE_ALIAS = {
  '客户系统运维': '公司网站运维',
};

/** 把旧名/别名收敛成当前正式名；没命中原样返回 */
function canonSceneName(x) {
  const k = String(x == null ? '' : x).trim();
  return SCENE_ALIAS[k] || k;
}

// 目标既可以是场景 id，也可以是场景显示名（上游发消息.mjs 两种都收）
function resolveTarget(scenes, key) {
  const k = canonSceneName(key);
  if (scenes.has(k)) return scenes.get(k);
  for (const s of scenes.values()) if (s.name === k) return s;
  for (const s of scenes.values()) {
    if (s.panels.some((p) => p.sessionTitle === k || p.title === k)) {
      return { id: s.id, name: s.name, panels: s.panels.filter((p) => p.sessionTitle === k || p.title === k) };
    }
  }
  return null;
}

// ── RPC：cookie 认证（复用 绑定会话.mjs 的做法：从日志取 launch token 换 cookie）──
const TOKEN_RE = new RegExp('http:\\/\\/127\\.0\\.0\\.1:' + DSH_PORT + '(?:\\/\\?)?token=([A-Za-z0-9_\\-]{16,})', 'g');

async function getCookie() {
  const logs = [
    path.join(ROOT, '外壳', 'server.log'),
    path.join(ROOT, '引擎', 'server.log'),
  ];
  const toks = [];
  for (const lp of logs) {
    if (!fs.existsSync(lp)) continue;
    for (const m of fs.readFileSync(lp, 'utf8').matchAll(TOKEN_RE)) toks.push(m[1]);
  }
  toks.reverse();
  for (const t of toks.slice(0, 5)) {
    try {
      const r = await fetch('http://127.0.0.1:' + DSH_PORT + '/?token=' + t, { redirect: 'manual' });
      const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      if (sc.length) return sc.map((c) => c.split(';')[0]).join('; ');
    } catch { /* 下一个 token */ }
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

// ── --检查：只体检通道 ──────────────────────────────────────────────
async function checkOnly() {
  console.log('════ 派单通道体检 ════');
  const cookie = await getCookie();
  if (!cookie) { console.log('  ⛔ 拿不到引擎 cookie ⇒ 通道不通（引擎没跑？）'); return 1; }
  console.log('  ✓ 引擎 cookie 已拿到');

  const sl = await rpc(cookie, 'session/list', { _request: {} });
  const live = (sl && sl.result && sl.result.ok && sl.result.value && sl.result.value.items) || [];
  console.log('  ✓ 引擎会话库可读（' + live.length + ' 个会话）');

  const scenes = loadScenes();
  let ok = 0, bad = 0;
  console.log('\n  场景 → 面板 → 会话绑定：');
  for (const s of scenes.values()) {
    for (const p of s.panels) {
      const hit = live.find((x) => x.sessionId === p.sessionId);
      const name = hit && (hit.title || (hit.projections && hit.projections.values && hit.projections.values.title));
      if (hit) { ok++; console.log('    ✓ ' + s.name + ' / ' + p.title + ' → ' + p.sessionId.slice(0, 26) + '…  「' + (name || '?') + '」'); }
      else { bad++; console.log('    ⛔ ' + s.name + ' / ' + p.title + ' → 会话 ' + (p.sessionId || '(空)') + ' 在引擎里找不到'); }
    }
  }
  console.log('\n  绑定可用 ' + ok + ' 个，会话缺失 ' + bad + ' 个');
  return bad ? 1 : 0;
}

// ══════════════════════════════════════════════════════════════════════════
// ★★ 2026-11-02 三期·**--观察 模式**（只读，⛔ 一个字节都不写）★★
//
//   宿主/命令要的是「它现在在干嘛、动了哪些文件、还有多久」，
//   而不是再发一条消息去打断它问 —— 问一次就是一次中断。
//
//   ⇒ --观察：只读会话文件 + 只读引擎快照，打印三项：
//       ① 哪些文件（最近改动的 / 正在读的）
//       ② 多少步（累计 steps、本轮步数、当前这步跑了多久）
//       ③ 还差多久（按历史平均每步耗时估**当前这步**的剩余；总剩余无法推断就明说"无法推断"）
//
//   ⛔ 硬约束：这条路径**不许有任何 writeFileSync / appendFileSync / mkdirSync**，
//     连台账和看板都不写（观察不是派单，不该留下单据）。
//     验收方式是 mtime 前后对比（见 .lintax-tmp/验收-三期-观察.mjs）。
// ══════════════════════════════════════════════════════════════════════════
function readFrames(p) {
  // ★ 2026-11-06 15:1x 收敛：解码统一委托 _共用-会话解码.mjs
  return 帧文本(p);
}

async function observeOnly(scenes, t) {
  const target = t.panels.length === 1 ? t.panels[0]
    : t.panels.find((p) => p.sessionTitle && p.sessionTitle === 目标) || null;
  if (!target) {
    die('场景「' + t.name + '」有多个 AI 面板，--to 要写清楚是哪一个：'
      + t.panels.map((p) => p.title + '(' + p.sessionTitle + ')').join(' / '));
  }
  if (!target.sessionId) die('面板「' + target.title + '」没绑定会话 id');

  console.log('════ 观察（只读，不写任何文件）════');
  console.log('  场景：' + t.name + ' / 面板：' + target.title + ' / 会话：' + target.sessionId.slice(-8));

  // ── ① 引擎快照：running / steps / 当前步开始时间 ──
  let it = null, live = [];
  try {
    const cookie = await getCookie();
    if (!cookie) die('拿不到引擎 cookie ⇒ 观察不了（引擎没跑？）');
    const sl = await rpc(cookie, 'session/list', { _request: {} });
    live = (sl && sl.result && sl.result.ok && sl.result.value && sl.result.value.items) || [];
    it = live.find((x) => x.sessionId === target.sessionId) || null;
  } catch (e) {
    die('读引擎失败：' + ((e && e.message) || e));
  }
  if (!it) die('目标会话在引擎里不存在（' + target.sessionId + '）');
  const v = (it.projections && it.projections.values) || {};
  const ss = v.sessionStats || {};
  const steps = Number(ss.steps) || 0;
  const toolMs = Number(ss.toolMs) || 0;
  const llmMs = Number(ss.llmMs) || 0;
  const turns = Number(ss.turns) || 0;
  const openAt = Number(ss.openStep && ss.openStep.startTime) || 0;

  console.log('\n  ② 步数');
  console.log('     状态：' + (it.running ? '🔥 正在跑' : '💤 已停手'));
  console.log('     累计 steps=' + steps + ' · turns=' + turns
    + ' · 工具累计 ' + Math.round(toolMs / 1000) + 's · 模型累计 ' + Math.round(llmMs / 1000) + 's');
  if (openAt) {
    console.log('     当前这步：已跑 ' + Math.round((Date.now() - openAt) / 1000) + 's（startTime='
      + new Date(openAt).toLocaleTimeString('zh-CN', { hour12: false }) + '）');
  }

  // ── ② 会话文件：最近工具调用 → 哪些文件 ──
  let lastEventTime = 0;          // 会话里最后一条事件的 time（估算"当前这步跑了多久"的代理指标）
  const sf = (() => {
    const base = path.join(DSH_HOME, 'sessions');
    if (!fs.existsSync(base)) return '';
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, target.sessionId, 'session.v4.jsonl.zstd');
      if (fs.existsSync(p)) return p;
    }
    return '';
  })();
  if (!sf) {
    console.log('\n  ① 哪些文件：会话文件缺失，读不到');
  } else {
    const events = [];
    for (const fr of readFrames(sf)) {
      for (const ln of fr.split('\n')) {
        if (!ln.trim()) continue;
        let o = null; try { o = JSON.parse(ln); } catch { continue; }
        const tm = Number(o.time) || 0;
        if (tm > lastEventTime) lastEventTime = tm;
        if (o.type === 'tool/call' || o.type === 'tool_call' || o.type === 'toolCall') {
          let a = o.data?.arguments ?? o.arguments ?? '';
          for (let k = 0; k < 2 && typeof a === 'string'; k++) { try { a = JSON.parse(a); } catch { break; } }
          events.push({ seq: o.seq, time: tm, name: String(o.data?.name || o.name || ''), a: (a && typeof a === 'object') ? a : {} });
        }
      }
    }
    // 只看最近 40 次工具调用（早的已经被后面的覆盖，列出来没意义还给不出重点）
    const recent = events.slice(-40);
    const WRITE = new Set(['edit', 'write', 'apply_patch', 'str_replace', 'write_file', 'edit_file', 'multi_edit', 'create_file']);
    // 路径必须"像文件"：带扩展名。⛔ 不加这条会把 `cd 工作台`、`$root\工具\node.cmd`
    // 这类变量拼接的碎片当文件列出来（实测第一版就列了一堆 `root\工具\node.cmd`）。
    const FILE_RE = /(?:[A-Za-z]:\\[^\s"'`,;]+?\.[A-Za-z0-9]{1,6}|(?:[\w\u4e00-\u9fa5._-]+\\)+[\w\u4e00-\u9fa5._-]+\.[A-Za-z0-9]{1,6})/g;
    const touched = new Map();   // path → {n, write, last, name}
    for (const e of recent) {
      const cands = [];
      for (const k of ['file_path', 'path', 'notebook_path']) if (typeof e.a[k] === 'string') cands.push(e.a[k]);
      if (typeof e.a.command === 'string') for (const m of e.a.command.matchAll(FILE_RE)) cands.push(m[1]);
      for (const p0 of cands) {
        const p = String(p0).replace(/[.。,，;；]+$/, '');
        if (!/\.[A-Za-z0-9]{1,6}$/.test(p)) continue;      // 必须带扩展名
        if (/^root\\/i.test(p)) continue;                   // $root\… 这种变量碎片
        const cur = touched.get(p) || { n: 0, write: false, last: 0, name: '' };
        cur.n++;
        if (WRITE.has(e.name) || /Set-Content|Out-File|Copy-Item|Remove-Item|New-Item|>\s*['"]?[A-Za-z]:\\/i.test(String(e.a.command || ''))) cur.write = true;
        if (e.time >= cur.last) { cur.last = e.time; cur.name = e.name; }
        touched.set(p, cur);
      }
    }
    const list = [...touched.entries()].sort((a, b) => b[1].last - a[1].last);
    const writes = list.filter(([, x]) => x.write);
    console.log('\n  ① 哪些文件（最近 ' + recent.length + ' 次工具调用里出现的，共 ' + list.length + ' 个）');
    if (writes.length) {
      console.log('     ✍ 改过（' + writes.length + '）：');
      for (const [p, x] of writes.slice(0, 10)) console.log('        · ' + p + '  ×' + x.n);
    } else {
      console.log('     ✍ 改过：无（最近这段没有写操作）');
    }
    const reads = list.filter(([, x]) => !x.write).slice(0, 8);
    if (reads.length) {
      console.log('     👁 读过/碰过（前 8）：');
      for (const [p, x] of reads) console.log('        · ' + p + '  ×' + x.n);
    }
    // 最近一次工具调用（这是"它现在在干嘛"的最强信号）
    const last = recent[recent.length - 1];
    if (last) {
      console.log('\n     最近一次工具：' + last.name + '（seq=' + last.seq + '，'
        + (last.time ? new Date(last.time).toLocaleTimeString('zh-CN', { hour12: false }) : '时间未知') + '）');
    }
  }

  // ── ③ ETA：只能用"历史平均每步耗时"估**当前这一步**，总剩余无法推断就明说 ──
  //   ⚠ 实测本机 `sessionStats` 里**没有 openStep**（keys = turns/steps/llmMs/toolMs/
  //     ttftMs/ttftSteps/decodeMs/decodeTokens），所以"当前这步跑了多久"只能用
  //     会话文件里**最后一条事件的 time** 当代理（它 = 引擎最后一次写事件，
  //     长工具调用期间不更新 ⇒ 只能给下限，不能当精确值）。
  console.log('\n  ③ 还差多久');
  if (!it.running) {
    console.log('     已停手 ⇒ 没有"还差多久"，它这一轮完了（台账里有没有未回执请用 查回执台账.mjs）');
  } else if (steps <= 0) {
    console.log('     ⚠ 还没跑过一步 ⇒ **无法推断**（不编数字）');
  } else {
    const nowMs = Date.now();
    const avgTool = toolMs / steps / 1000;
    const avgLlm = llmMs / steps / 1000;
    const avgStep = avgTool + avgLlm;
    if (lastEventTime) {
      const sinceEvent = Math.round((nowMs - lastEventTime) / 1000);
      console.log('     最后一条会话事件在 ' + sinceEvent + 's 前（'
        + new Date(lastEventTime).toLocaleTimeString('zh-CN', { hour12: false }) + '）'
        + ' —— 这段"没新事件"通常说明它正在跑一个长工具/长思考');
    }
    if (!(avgStep > 0)) {
      console.log('     历史平均拿不到 ⇒ **无法估剩余**（不编数字）');
    } else {
      console.log('     历史平均每步约 ' + Math.round(avgStep) + 's（工具 ' + Math.round(avgTool)
        + 's + 模型 ' + Math.round(avgLlm) + 's，基于 ' + steps + ' 步 / ' + turns + ' 轮）');
      if (lastEventTime) {
        const curSec = Math.round((nowMs - lastEventTime) / 1000);
        const eta = Math.round(avgStep - curSec);
        console.log('     ⇒ **这一步**估计还要 ' + (eta > 0 ? eta + 's' : '0s（已超平均，正在跑长任务）'));
      }
      console.log('     ⚠ **整单还剩多久无法推断** —— 剩几步取决于还有多少活，只有它自己知道。');
      console.log('        （要它自己估，得有人问它；--观察 是只读的，不会去打扰它。）');
    }
  }
  console.log('\n  （本模式**没有写任何文件**：不落台账、不写看板、不改 state）');
  return 0;
}

// ── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  // ★★ 2026-11-05 10:27 宿主令「直接改」：派单正文机械剥离运行时内务串 ★★
  //   15:2x 改为 import 共享模块（广播派单同款），⛔ 不再在本文件里维护第二份词表。
  //   病根（10:03 派单实测）：正文被夹带 ACP 内务文本 ⇒ 接收方先花十几分钟裁决元规则，
  //   一个真实动作都不做。这类文本**不是宿主指令** ⇒ 投递前按行剥掉。
  const { 净: 净正文, n: 剥了几行 } = 剥运行时内务(正文);
  if (剥了几行) console.log('〔派单正文〕已剥离 ' + 剥了几行 + ' 行运行时内务串（非宿主指令，不投递给场景）');

  // ★★ 2026-11-05 00:11 宿主深夜令（机械闸，不靠人记）★★
  //   原话：「禁止出现让我自己手动选择的情形，一切自己判断；派单的任务也必须你不出现这种情况」
  //   ⇒ 派单正文里凡出现把决断踢回宿主/让场景来问的句式，直接拒投 exit 1。
  //   不确定就自己按证据定，定错自己认，⛔ 不许发选择题。
  //   ⚠ 坑㊲ 同型修法（00:27 实测踩过）：**引用宿主禁令/事故教训的行要豁免** ——
  //     正文里写「禁止让宿主手动选择」是在**重申规矩**，不是违规；裸词 `ask_user_question`
  //     也会命中讲规矩的说明行。⇒ 先按行剔掉引用行，再用句式正则扫剩下的行。
  function 禁手动选择(txt) {
    const QUOTE = /原话|深夜令|禁止出现|禁止让|事故链|教训|叠加|不许调/;
    const scan = String(txt || '').split('\n').filter((l) => !QUOTE.test(l)).join('\n');
    const BAD = [
      /请宿主(选|选择|决定|确认|裁定|给|提供)/,
      /让宿主(选|选择|决定|自己|来)/,
      /请(你|宿主)?(选一个|确认一下选哪个|告诉我选哪个)/,
      /二选一|三选一|多选一|选A还是B|A.{0,4}B.{0,4}C|选项A|选项B/,
      /让用户自己选|等你确认后才做|请你选一个|请宿主定夺|问宿主选|问宿主定/
    ];
    const hit = BAD.filter((re) => re.test(scan));
    if (!hit.length) return;
    console.error("⛔ 派单正文出现「让宿主/场景手动选择」的句式 ⇒ 已拒投（宿主 00:11 深夜令）。");
    console.error("   命中：" + hit.map(String).join(" · "));
    console.error("   正解：自己按证据定归属/方案，正文写「已定：X，理由：…」，⛔ 不许发选择题。");
    process.exit(1);
  }
  禁手动选择(净正文);

  // ★★ 00:34 宿主令「活不要全派给程序开发，他的积分不够」——机械分流闸 ★★
  //   近 30 分钟给同一场景派 ≥3 单 ⇒ 拒投；命令/别场景能做的自己接。
  //   ⛔ 放在 --检查/--观察/--干跑 之前会误伤只读分支；放在真投递前最准（目标此时已解析）。
  //   ⛔ 台账不可读只标未知，不静默判绿。
  if (!has('--干跑')) {
    const { 分流检查 } = await import('./派单分流.mjs');
    // ⛔ `--减负` 只能用在「撤回 / 销账 / 不用做」这类**不给对方加活**的通知；
    //   分流闸仍如实打印近 30 分钟已派单数，只是不算新增活 ⇒ 不静默关闸、不放宽统计。
    分流检查(目标 || '', { 减负: has('--减负') });
  }

  if (has('--检查')) { process.exit(await checkOnly()); }

  const scenes0 = loadScenes();
  // ★ 三期：--观察 走只读分支，**在"必须有正文"的校验之前**，
  //   因为观察不需要正文，也不该产生任何单据。
  if (has('--观察')) {
    if (!目标) die('用法：node 工具\\派单.mjs --观察 --to <场景或面板>');
    const tt = resolveTarget(scenes0, 目标);
    if (!tt) die('找不到场景「' + 目标 + '」。现有：' + [...scenes0.values()].map((s) => s.id).join(' / '));
    process.exit(await observeOnly(scenes0, tt));
  }

  if (!目标 || !净正文) {
    console.error('（正文若全是运行时内务串，已在投递前剥掉 ⇒ 不会发空单）');
    console.error('用法：');
    console.error('  node 工具\\派单.mjs --to <场景> --正文文件 <文件> [--干跑]   # ★推荐，长正文必用');
  console.error('  node 工具\\派单.mjs --to <场景> --正文 "…" [--干跑]');
    console.error('  node 工具\\派单.mjs --检查');
    process.exit(1);
  }

  const scenes = loadScenes();
  const t = resolveTarget(scenes, 目标);
  if (!t) die('找不到场景「' + 目标 + '」。现有：' + [...scenes.values()].map((s) => s.id).join(' / '));

  // 一次派单只打一个会话（上游：同一场景两个 harness 不能串台；派单要指明是谁）
  const target = t.panels.length === 1 ? t.panels[0]
    : t.panels.find((p) => p.sessionTitle && p.sessionTitle === 目标) || null;
  if (!target) {
    die('场景「' + t.name + '」有多个 AI 面板，--to 要写清楚是哪一个：'
      + t.panels.map((p) => p.title + '(' + p.sessionTitle + ')').join(' / '));
  }
  if (!target.sessionId) die('面板「' + target.title + '」没绑定会话 id（先跑 工具\\绑定会话.mjs）');

  // ── ★ 二期：生成本单的授权范围 ────────────────────────────────────
  const mandate = defaultMandate(t.id, t.name);
  const 允许 = vals('--允许'), 禁止 = vals('--禁止'), 验收项 = vals('--验收');
  if (允许.length) mandate.allowPaths = 允许;          // 命令行覆盖（可重复传）
  if (禁止.length) mandate.denyPaths = 禁止;
  if (验收项.length) mandate.验收 = 验收项;

  // ── 【2026-11-02 修·宿主定规矩】────────────────────────────────────
  //   原话：「凡是你进行派单的，结束都要给你回执，场景不是单向的」
  //   病根：老派单正文只写「■ 回执：四件套」，**没写回执怎么回来**。
  //         场景在自己会话里说一遍，自认为"回了"；命令这边看板 0 条。
  //         实测：DSH改造 15:52 那次是它自觉发的；GUI页面改造 到第 10 回合看板仍 0 条。
  //   ⇒ 回执指令由工具**强制注入**，不靠我每次记得写。这是"单向通道"的根因。
  //   防重复：正文里已含 `发消息.mjs` 就不再注入；旧尾部「■ 回执」段先剥掉。
  const 回执行 = [
    '',
    // ★ §11.35：回执不再让模型手写四件套（轮5 实测为投两份回执多花 3 次 pwsh），
    //  收敛成「交付只跑闭环一条」，由 闭环.mjs --回执 代发；⛔ 不另跑发消息.mjs。
    '■ 回执（闭环代发）：交付只跑 `node 工具\\闭环.mjs --场景 <场景名> --回执 "【<场景名>】结论…/证据…/落盘…/还差…"`，末行【结束】；⛔ 不另跑发消息.mjs、不手写四件套、只写自己会话里＝没回执。卡住也回「未完成 + 卡在哪」。',
  ].join('\n');

  let body = 净正文.trimEnd().replace(/【结束】\s*$/, '').trimEnd();

  // ★ 2026-11-06 16:4x 真探针实证（B站 轮42，16.02s / 2 工具 / 回复 338 字）：
  //   宿主原话「统计…把数字报给我，不要改任何文件」是只读查数单，
  //   出口却仍强制注入「交付只跑 闭环.mjs --回执」＋「■ 授权范围」两段模板；
  //   模型照模板跑了闭环，闭环 ③ 定位卡刷新真重生成 `身份卡.md` / `场景画像.md`
  //   （两份 mtime 16:37 实锤）⇒ 唯一指令与模板互斥，等于逼它改文件。
  //   ⇒ 只读单走「只读出口」：不跑闭环、不写业务文件；回执改用一条轻量 发消息.mjs 代发。
  //   ⛔ 只认「明确禁写文件」的措辞，⛔ 不误伤正常办事单（授权段／闭环代发原样保留）。
  //   ⛔ 只判「第一条实质行」＝宿主唯一指令，⛔ 不拿背景段里的「不要改任何文件」当本单性质
  //     （16:4x 回归实证：长轻链真跑正文背景第 126 行就有这句，整篇匹配会把 A 类轻链误判成只读单）。
  const 首实质行 = 净正文.split(/\r?\n/).map((l) => l.trim())
    .find((l) => l && !/^(【派单|〔上游背景|■|⛔|…|#{1,6}\s)/.test(l)) || '';
  const 只读单 = /不要改(任何)?文件|不改(任何)?文件|不要写(任何)?文件|不写(任何)?文件|不要动(任何)?文件|不动(任何)?文件|不得(改|写)(任何)?文件|不要落盘|不落盘|只做统计|只统计|仅统计|只读统计/.test(首实质行);

  // ★ §11.35 换链：宿主原话前置、上游推理降级为「只读背景」、交付收敛成一条命令。
  //   实测轮5 宿主原话 18 字被包成 1421 字 ⇒ 931.8s / 14 工具 / 129456 字 reasoning。
  //   --原样 是逃生开关（机制自测 / 特殊长协议单），⛔ 正常派单不走它。
  let 轻链 = false;
  if (!process.argv.includes('--原样')) {
    const 结 = 结构化正文(body, t.name);
    body = 结.文本;
    // ★ §11.36：A 类给死答案被长正文裹住时走轻链 ⇒ 出口不许再追加回执段/授权范围模板，
    //   否则第一行「不要思考、0 工具」与后面「跑闭环发回执」又变成并列指令。
    轻链 = !!结.轻;
    console.log('〔派单结构化〕' + 结.原长 + '→' + 结.新长 + ' 字'
      // ★ §11.44：等待型也走 `轻`（不套办事链），但日志要区分，别把「投递完收尾」记成 A 类给死答案。
      + (结.等 ? '｜等待型收尾链（不套办事链）' : 轻链 ? '｜A 类轻链（不套办事链）' : '')
      + (结.原话 ? '｜唯一指令：' + 结.原话 : '｜未标原话'));
  }
  // ★ §11.35 单一真源：结构化模块已经给了唯一的「■ 交付（只跑这一条）」段
  //   （含 --回执 / 末行【结束】 / 卡住也回 / 场景真名），⛔ 这里不许再追加第二个回执段。
  //   22:3x 真实 --干跑 复算抓到两个口径打架：`--场景 工作台改造` 与 `--场景 <场景名>`
  //   并列排在正文里 ⇒ 模型把它们当两条指令逐条回应，正是本轮要根治的结构缺陷。
  //   `--原样` 逃生开关下没走结构化，仍由下面的旧回执行兜底。
  //
  // ★ 2026-11-06 11:2x：**作者已经写明回执通道 ⇒ 不许再注入第二套**（真事故，见 正文已带回执通道 注释）。
  //   09:27 调度测试那张正文让场景跑 `发消息.mjs --回执` 交四件套，
  //   追加的尾巴却写 `⛔ 不另跑发消息.mjs` ⇒ 自我复盘在推理里裁决了半天，最后只在自己会话回了
  //   「收到」两个字，看板 0 条 ⇒ 假未回执。两条互斥指令是我造的，不是它不听话。
  if (!只读单 && !轻链 && !正文已带回执通道(body)
      && !/■ 交付（只跑这一条）/.test(body) && !/■ 回执（闭环代发）/.test(body)) {
    // 剥掉旧的收尾「■ 回执」小段，避免出现两个回执段。
    // 判据必须是「关系」不是「长度」：候选段得**看起来就是收尾的回执段**——
    // ① 标记独占行首（`^■ 回执`，多行模式）；② 段长 ≤600；③ 段里有 四件套/【结束】/结论 之一。
    // （前一版只比长度，正文中间提一句"■ 回执"就把后面 400 字全切了，已实测抓到。）
    const tailM = body.match(/(^|\n)[ \t]*■\s*回执[^\n]*\n([\s\S]*)$/);
    if (tailM) {
      const seg = tailM[2];
      if (seg.length <= 600 && /四件套|【结束】|结论/.test(seg)) body = body.slice(0, tailM.index).trimEnd();
    }
    body = body + '\n' + 回执行;
  }

  // ── ★ 二期：授权范围写进正文（P3 瘦身：3 行，⛔ 不再塞 TOOL_OWNER 长表）──
  //   10:03 实测：长模板 + 内务串让接收方花 9 分钟裁决元规则，答题链被吞。
  //   边界仍写在正文里；台账 mandate 字段不变 ⇒ 回执对账不破坏。
  // ★ §11.36：轻链不注入授权范围/通用自检模板（A 类 0 工具，套上就是并列指令）。
  //   台账 mandate 仍完整落账（下方 mandate 字段不变）⇒ 查回执台账对账不破坏。
  if (!只读单 && !轻链 && !body.includes('■ 授权范围')) {
    const 允 = mandate.allowPaths.length ? mandate.allowPaths.join(' · ') : '（无）';
    const 禁 = mandate.denyPaths.length ? mandate.denyPaths.join(' · ') : '（无）';
    // ★ §11.35：结构化后交付段已写「⛔ 不写验收脚本／不逐项自检」，
    //   而 SCENE_SCOPE 的默认验收模板仍要求「真实面板自检/探针数据落盘 / node --check」
    //   ⇒ 两条口径打架，正是轮5 模型交付后自增殖写验收脚本、soft 热更、盘点热更的指令来源。
    //   收敛：正文只留**安全红线**（不许/只能/禁止/⛔/备份），通用自检项交给闭环第四环。
    //   ⛔ 只改正文展示；台账 mandate.验收 原文不动 ⇒ 查回执台账对账不破坏。
    const 结构化生效 = /■ 交付（只跑这一条）/.test(body);
    const 验收展示 = 结构化生效
      ? mandate.验收.flatMap((x) => String(x).split(/[；;]/)).map((x) => x.trim())
          .filter((x) => x && /不许|只能|禁止|⛔|备份/.test(x))
      : mandate.验收;
    body += '\n' + [
      '',
      '■ 授权范围：允许 ' + 允 + ' ｜ 禁止 ' + 禁 + '（`_原始包备份\\` 全局豁免，动手前先备份）',
      验收展示.length ? '  安全红线：' + 验收展示.join('；') : '',
      结构化生效 ? '  通用自检由闭环第四环统一跑；⛔ 不另写验收脚本／不另落自检数据。' : '',
      '  回执「落盘」写真实改动路径；越权会自动比对出来。',
    ].filter((x) => x !== '').join('\n');
  }

  // ★ 只读单唯一出口：一个答案 + 一条轻量回执，⛔ 不套闭环（会改文件）／不套授权范围。
  //   「凡派单结束都要回执」的宿主规矩仍守，只是把回执通道从会写盘的闭环换成单条 发消息.mjs。
  if (只读单 && !轻链) {
    body += '\n' + [
      '',
      '■ 只读单（唯一出口）：把答案直接回复本会话，末行【结束】。',
      '⛔ 不跑 `闭环.mjs`（它会重生成身份卡／场景画像＝改文件）、不写任何业务文件、不重生成定位卡、不落盘。',
      '命令侧回执只跑一条 `node 工具\\发消息.mjs --to 命令 --回执 "【<场景名>】结论…／证据…／落盘：无（本单只读）／还差…"`，⛔ 不手写四件套。',
    ].join('\n');
  }

  // ★ 16:0x：互斥裁决必须放在**所有尾部拼接之后** —— §11.35 的「剥旧 ■ 回执」切片
  //   会把提前追加的内容一起切掉（16:0x 真干跑实证：日志说命中、正文却没有）。
  //   放在这里，正常派单与 --原样 都能吃到，且不会被后续任何切片/拼接抹掉。
  const 裁决 = 互斥裁决(body);
  if (裁决) {
    body = body + '\n' + 裁决;
    console.log('〔派单互斥裁决〕已收敛「不重启 × 主进程改动」冲突');
  }

  const full = '【派单】' + body + '\n【结束】';

  console.log('════ 派单 ════');
  console.log('  场景：' + t.name + ' / 面板：' + target.title + ' / 会话：' + target.sessionTitle);
  console.log('  正文：\n    ' + body.replace(/\n/g, '\n    '));

  if (干跑) {
    console.log('\n  （--干跑：没真的发）');
    return 0;
  }

  const cookie = await getCookie();
  if (!cookie) die('拿不到引擎 cookie ⇒ 通道不通。**按 L0 §6「通道不通不派单」，已停下，未投递。**');

  // 先确认目标会话在引擎里真实存在（投递前体检，别把单发进黑洞）
  const sl = await rpc(cookie, 'session/list', { _request: {} });
  const live = (sl && sl.result && sl.result.ok && sl.result.value && sl.result.value.items) || [];
  if (!live.find((x) => x.sessionId === target.sessionId)) {
    die('目标会话在引擎里不存在（' + target.sessionId + '）⇒ 送不进去。**已停下，未投递。**');
  }

  const r = await rpc(cookie, 'session/prompt', {
    request: {
      requestId: 'dispatch-' + Date.now(),
      sessionId: target.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: full }],
    },
  });
  const ok = r && r.result && r.result.ok && r.result.value && r.result.value.accepted;
  if (!ok) {
    console.error('  ✗ 投递失败：' + JSON.stringify((r && (r.result || r.error)) || r).slice(0, 300));
    console.error('  ⇒ 按 L0 §6「通道不通不派单」，**没落盘、没假装已发**。');
    process.exit(1);
  }
  // ── 【2026-11-02 加·宿主定规矩】派单台账：凡是我派出的单，必须有一行账 ──
  //   宿主：「凡是你进行派单的，结束都要给你回执，场景不是单向的」
  //   光靠看板不行：看板只有"回了"的记录，**没回的不留痕** ⇒ 变成我凭记忆追。
  //   ⇒ 投递成功那一刻落一行，`工具\查回执台账.mjs` 按这行去会话里核回执，
  //      没回执 = 红条列出，跑不掉。这是把"记得追"换成"结构上追不到就报警"。
  // ── 【2026-11-03 加·宿主「加呗」】派单优先级闸：先派单、再分析 ──
  //   宿主原话：「你既然知道不是自己的地盘，其实一分钟就能分析报错然后转发给其他场景，
  //     为什么要分析 20 分钟都不发给其他场景呢？我要你把派单给其他场景优先级调高！！！」
  //   病根：「我什么时候判定的」这件事**从来没留痕** ⇒ 事后无法自证、也无法机检。
  //   解法：`工具\开工打点.mjs --宿主 "…"` 把"判定归属"变成一次写盘；这里读那条打点算延迟。
  //   ⚠ 判红**不拦派单**（活必须出去，这是第一优先）；但会**落进台账 + 退出码 3**，
  //     所以 `查回执台账.mjs` 和任何 CI 都能看见。宁可拦不住也要留下证据。
  let priority = null;
  try {
    const { lastOpenPoint, judgeNow, readPoints, consumePoint } = await import('./开工打点.mjs');
    // ★★ 2026-11-05 05:0x（坑57）：不再用 `lastOpenPoint()` 单取一条。
    //   老写法的后果（实测，不是推测）：宿主一句话拆两单时，
    //   第一单拿走了打点，第二单 `lastOpenPoint()` 返 null ⇒ 被判「没有打点起点 ⇒ 按违反处理」。
    //   21:10:51 程序开发（真实延迟 178 秒）、21:29:12 程序开发（真实延迟 23 秒）
    //   就是这么被冤枉的 —— 两条都在 300 秒红线内。
    //   ⇒ 把「取哪条打点」交给 `judgeNow`：它按关系挑（未消费 / 本单即消费方 / 同批拆单 / 过期），
    //     延迟一律从打点时刻算起，⛔ 绝不拿 consumedAt 当起点（那会把拖延洗成合规）。
    const j = judgeNow(Date.now(), readPoints());
    priority = { ok: j.ok, delaySec: j.delaySec, reason: j.reason + (j.via ? '［' + j.via + '］' : ''), pointAt: j.pointAt };
    // 消费仍然只消费「当前未消费的那条」：已消费的打点不许被第二单重复记账。
    const pt = lastOpenPoint();
    if (!j.ok) {
      console.error('\n  ⛔ 派单优先级：' + j.reason);
      console.error('     ⇒ 违反「先派单，再分析」。这次单**照样发出去**（活不能压在手上），');
      console.error('        但台账会记 `priorityOk:false`，`查回执台账.mjs` 会红。');
      console.error('     下次节奏：收到宿主的话 → 立刻 `node 工具\\开工打点.mjs --宿主 "<原话>"` → 1 分钟内派。');
    }
    // ★★ 2026-11-03 16:5x 修：**不管合规还是违规，只要真派出去了就消费掉这条打点。**
    //
    //   老写法把它写在 `else if (pt)` 里 —— 只有合规才消费。
    //   后果（实测，不是推测）：16:32 那条打点超时 798 秒判红之后，
    //   `--状态` 一直显示「未派单，距今 806 秒」，**之后每一单都会继续拿这条旧打点计时**，
    //   ⇒ 一次违规变成**永久红**，台账天天报警，报警也就没人看了（= 报警疲劳）。
    //   判据是关系：一条打点服务的是「它之后的第一单」，派完就该退休，
    //   ⛔ 跟这一单合不合规**没有关系**。
    //   （违规这件事已经落在 `priority.ok=false` + 退出码 3 里，跑不掉。）
    if (pt) consumePoint(pt, t.name);
  } catch (e) {
    priority = { ok: null, delaySec: null, reason: '闸自身出错（不拦单）：' + ((e && e.message) || e) };
    console.error('  ⚠ 派单优先级闸出错（不影响本次投递）：' + ((e && e.message) || e));
  }
  try {
    const LEDGER = path.join(ROOT, 'L1共享层', '_共享记忆', '_派单台账.jsonl');
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    const tsLocal = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); })();
    // ★ 坑72：head 取「第一条不是模板套话的行」——判据要看实质内容，不看壳（实现见 ledgerHead）。
    fs.appendFileSync(LEDGER, JSON.stringify({
      ts: tsLocal,
      scene: t.name, panel: target.title, sessionTitle: target.sessionTitle,
      sessionId: target.sessionId,
      // ★★ 2026-11-06 01:0x（坑72，我自己踩的）：台账 head 原来取「正文第一行」，
      //   而结构化正文的第一行是**模板套话**（`【本单指令】按正文第一句做；⛔ 本次没标「原话：」…`），
      //   于是**所有单在台账里长得一模一样**。实测 8 行受影响（自我复盘/工作台改造/命令/程序开发）。
      //   后果不是"不好看"，是判据失效：`contentScore(单.head, 回执.body)` 永远对不上，
      //   `identityOk` 分不出是哪一单，只能靠时间就近硬配 ⇒ 00:28:52 与 00:29:03 两行同会话、
      //   head 全同、mandate 全同，台账把它当成两张不同的活，其中一张永远等不到回执（假红）。
      //   ⇒ 关系式修法：head 取**第一条不是套话的行**；整篇只有套话时才退回第一行（宁可难认，不许编）。
      head: ledgerHead(body), headRaw: ledgerHeadRaw(body),
      accepted: true,
      mandate,                       // ★ 二期：授权范围随单落账，回执核账时逐条比对
      priority,                      // ★ 2026-11-03：派单优先级闸的结果（ok/delaySec/reason）
    }) + '\n', 'utf8');
  } catch (e) {
    console.error('  ⚠ 派单台账写入失败（不影响本次投递，但这条追不回来了）：' + ((e && e.message) || e));
  }

  console.log('\n  ✓ 已真投递（session/prompt → accepted:true），对方会话已被唤醒。');
  console.log('  下一步：等回执。回执四件套 = 结论 + 证据 + 落盘路径 + 还差什么。');
  console.log('  查回执：node 工具\\查回执台账.mjs');
  // ⛔ 退出码 3 = 「单发出去了，但违反派单优先级」。不拦单，只留痕。
  //    这样任何脚本/CI 串 `派单.mjs` 时不会把违规当成成功吞掉。
  if (priority && priority.ok === false) {
    console.error('\n  ⛔ 退出码 3：本次派单违反「先派单，再分析」（' + priority.reason + '）');
    return 3;
  }
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════
// ★ 2026-11-03 加：`派单.mjs --自测`（纯函数断言，不写文件、不连引擎）
//
//   为什么现在才有：这文件以前**零断言**。今天在它身上犯的两个错都是"看着对"：
//     ① `SCENE_SCOPE['dsh-gui']` 漏了 `D:\Lintax数据\项目\工作台改造\`
//        ⇒ 工作台改造 按宪法写了主题文档，反被判「越权」；
//     ② `TOOL_OWNER` 第一版 8 条幽灵条目（表里有、磁盘没有）+ 4 个正式脚本漏登。
//   两个错都不会让 `node --check` 红，也不会让程序崩 —— 只会**悄悄判错人**。
//   ⇒ 判据必须能被跑出来。
// ══════════════════════════════════════════════════════════════════════════
if (has('--自测')) {
  const cases = [];
  const T = (n, got, want) => cases.push([n, got, want]);

  // ── ① 工具归属表：查得到 / 查不到 / 边界 ──
  T('① 命令的派单.mjs 归 command', toolOwner('工具\\派单.mjs'), 'command');
  T('①-b 程序开发的交接脚本归 code-dev', toolOwner('工具\\交接.mjs'), 'code-dev');
  T('①-c 绝对路径也要认', toolOwner('D:\\Lintax数据\\工具\\发消息.mjs'), 'command');
  T('①-d 正斜杠也要认', toolOwner('工具/查回执台账.mjs'), 'command');
  T('①-e ⛔ 不在 工具\\ 下的文件不许瞎认', toolOwner('外壳\\main.js'), '');
  T('①-f ⛔ 没登记的文件返回空（不指控）', toolOwner('工具\\_一次性脚本.mjs'), '');
  T('①-g ⛔ 空值不炸', toolOwner('') + toolOwner(null), '');

  // ── ② 归属表完整性：磁盘上的**正式**脚本必须全登记 ──
  //   判据是关系型：不是数个数，而是"磁盘集合 ⊆ 表集合"。
  {
    let missing = [], ghost = [];
    try {
      // ⛔ 排除「不是正式脚本」的：.bak / .备份- （本机实际用的是「.备份-<改动>-<时间戳>.mjs」命名），
      //    以及 _ 开头的临时脚本。否则备份文件会被当成「漏登记的正式脚本」——判据就不描述关系了。
      const real = fs.readdirSync(path.join(ROOT, '工具'))
        .filter((f) => f.endsWith('.mjs') && !f.includes('.bak') && !f.includes('.备份') && !f.startsWith('_'));
      for (const f of real) if (!TOOL_OWNER[f]) missing.push(f);
      // 幽灵：表里有、磁盘上没有（改名/删除后忘了同步）
      const realSet = new Set(fs.readdirSync(path.join(ROOT, '工具')));
      for (const f of Object.keys(TOOL_OWNER)) if (!realSet.has(f)) ghost.push(f);
    } catch (e) { missing = ['读不到工具目录：' + ((e && e.message) || e)]; }
    T('② 正式脚本全部已登记（缺=' + missing.join(',') + '）', missing.length, 0);
    T('②-b 表里没有幽灵条目（多=' + ghost.join(',') + '）', ghost.length, 0);
  }

  // ── ③ 授权范围：项目信息目录必须放行（今天被误判的那条）──
  {
    const m = defaultMandate('dsh-gui', '工作台改造');
    const hasProj = (m.allowPaths || []).some((p) => /项目[\\/]工作台改造/.test(p));
    T('③ dsh-gui 的默认授权含它自己的 项目\工作台改造\（宪法 §10 要求它写主题文档）', hasProj, true);
    const mc = defaultMandate('command', '命令');
    T('③-b command 的默认授权含 项目/命令/', (mc.allowPaths || []).some((p) => /项目[\\/]命令/.test(p)), true);
    // 反样本：别的场景的项目目录不许被顺手放行
    T('③-c ⛔ dsh-gui 的授权不含 项目/个人站点/', (m.allowPaths || []).some((p) => /个人站点/.test(p)), false);
  }

  // ── ③-d/e/f 第十四次巡检 2026-11-05 07:25：design-misc 收窄的正反样本 ──
  {
    const md = defaultMandate('design-misc', '设计杂活');
    T('③-d ⛔ design-misc 默认授权不再含 引擎\\.dsh\\profiles\\web\\（装插件窄口不长期开放）',
      (md.allowPaths || []).some((p) => /profiles[\\/]web/.test(p)), false);
    T('③-e 收窄没误删它自己的两个目录（记忆目录 + 项目目录）',
      (md.allowPaths || []).some((p) => /L2场景私有[\\/]设计杂活/.test(p)) &&
      (md.allowPaths || []).some((p) => /项目[\\/]设计杂活/.test(p)), true);
    const probe = defaultMandate('design-misc', '设计杂活');
    probe.allowPaths.push('引擎\\.dsh\\profiles\\web\\');   // 模拟 --允许 逐单覆盖只改本单副本
    T('③-f 逐单授权不污染全局表（收窄后仍可临时授权装插件）',
      defaultMandate('design-misc', '设计杂活').allowPaths.some((p) => /profiles[\\/]web/.test(p)), false);
  }

  // ── ④ 未知场景必须"宁可严" ──
  {
    const m = defaultMandate('不存在的场景id', '某场景');
    T('④ 未知场景只给自己记忆目录', m.allowPaths.length, 1);
    T('④-b 未知场景的 allow 是它自己的目录', /某场景/.test(m.allowPaths[0]), true);

  // ── ⑤ 台账 head 必须是「本单实质内容」，⛔ 不是模板壳（坑72）──
  //   为什么单独立一条：8 行台账 head 全同 ≠ 8 张一样的活，而是**判据认不出人**；
  //   一旦认不出，回执就只能按时间硬配 ⇒ 同会话两单必有一单永远空手（实测 00:28:52）。
  {
    const 套话 = '【本单指令】按正文第一句做；⛔ 本次没标「原话：」，别把上游推测当新指令。';
    const 真活 = '把「个人站点」和「视频工作流」两个场景也先隐藏';
    T('⑤ 有实质行时 head 必须是实质行，⛔ 不是套话', ledgerHead(套话 + '\n' + 真活), 真活);
    T('⑤-a 只有套话时退回第一行（宁可难认，不许编）', ledgerHead(套话), 套话.slice(0, 120));
    T('⑤-b 空正文不许炸', ledgerHead('') + ledgerHead(null), '');
    //   反样本：老写法（取第一条非空行）在这份正文上会吐出套话 ⇒ 必须能红。
    const 老写法 = (b) => String(b || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    T('⑤-c ⛔ 反证：老写法在这份正文上确实取到套话（说明这条断言抓的是真差异）',
      老写法(套话 + '\n' + 真活) === 真活, false);
    //   真实原文（00:28:52 那单投进会话的开头三条）：第①行是占位套话、第②行是固定壳、
    //   第③行才是这一单真正要人做的事 ⇒ head 必须落在第③行。
    const 真原文 = "【派单】【本单指令】按正文第一句做；⛔ 本次没标「原话：」，别把上游推测当新指令。\n⛔ 只做这一句；下面是背景与工具口径，不是新指令。\n1. **回执只有「结论」一段**。23:52 那条 314 字符。";
    T('⑤-d 真实样本：三条壳之后第一条实质行才是 head（得到=' + ledgerHead(真原文).slice(0, 12) + '…）',
      /^1\. \*\*回执只有/.test(ledgerHead(真原文)), true);

  // ── ⑤-e ~ ⑤-j（坑74）：**带序号的段标题是壳**，不带宽号的标题是主题（内容）──
  //   真实事故（2026-11-06 05:52 那张重派单，投进会话的原文）：第 0 行占位套话、
  //   第 1 行 `## 四、⛔ 硬要求` ⇒ 旧写法把标题当 head ⇒ 台账认不出这一单，
  //   它 06:29 交了完整回执却被判「未回执 + 逾期」。
  //   判据读的是「这一行描述的是**内容**还是**结构**」，不是「这一行长什么样」。
  {
    const 带标题 = '【派单】【本单指令】按正文第一句做；⛔ 本次没标「原话：」，别把上游推测当新指令。\n## 四、⛔ 硬要求\n4. **落盘必须写完整路径**，并写改前备份在哪。';
    T('⑤-e 带序号的段标题不算 head（得到=' + ledgerHead(带标题).slice(0, 10) + '…）',
      /^4\. \*\*落盘/.test(ledgerHead(带标题)), true);
    //   反证：老写法（只跳原有 7 条壳）在这份正文上确实吐出标题 ⇒ 说明这条断言抓的是真差异。
    const 老壳 = [/^【本单指令】按正文第一句做/, /^〔上游背景·只读〕/, /^⛔ 只做这一句；下面是背景与工具口径/, /^■ 交付（只跑这一条）/, /^■ 授权范围：/, /^■ 回执/, /^…（背景/];
    const 老写法2 = (b) => { const ls = String(b || '').replace(/^\s*【派单】/, '').split('\n').map((l) => l.trim()).filter(Boolean); return (ls.find((l) => !老壳.some((re) => re.test(l))) || ls[0] || '').slice(0, 120); };
    T('⑤-f ⛔ 反证：只跳旧 7 条壳时确实取到标题（说明 ⑤-e 抓的是真差异）',
      老写法2(带标题), '## 四、⛔ 硬要求');
    //   ⛔ **关键反样本（我第一版就是在这里翻车的）**：不带宽号的标题是**主题**，必须当 head。
    //      11-03 有六张老单的 head 就是 `# 派单 · 工作台改造 · 引擎自动注入缺口…` 这种，
    //      一律当壳跳掉，等于把「这单干什么」删了。
    const 主题标题 = '【派单】# 派单 · 工作台改造 · 引擎自动注入缺口（只注入 oa-context.md）\n正文……';
    T('⑤-g ⛔ 不带宽号的标题是主题，必须当 head（不许一并跳掉）',
      /^# 派单 · 工作台改造/.test(ledgerHead(主题标题)), true);
    //   ⛔ 反样本：正文里**不是行首**的 `#` 不许被当标题跳掉。
    const 行内井号 = '【派单】【本单指令】按正文第一句做；\n第 3 条讲 `C#` 与 `#标签` 的用法，请照做';
    T('⑤-h ⛔ 行内 `#` 不算标题，正常句子仍当 head',
      /^第 3 条讲/.test(ledgerHead(行内井号)), true);
    //   ⛔ 反样本：整篇只有壳 + 带序号标题 ⇒ 退回第一行，不许返回空。
    const 全壳 = '【派单】【本单指令】按正文第一句做；\n## 一、背景\n### 1.1 细节';
    T('⑤-i 整篇只有壳和段标题时退回第一行、不返回空串',
      ledgerHead(全壳).length > 0, true);
    //   ⛔ 反样本：`## 四、硬要求` 与 `## 一、背景` 都要跳；`### 1.1 细节`（阿拉伯数字带点）也要跳。
    const 多级 = '【派单】## 一、背景\n### 1.1 细节\n### 2.2 细节\n真正要做的事';
    T('⑤-j 阿拉伯数字/中文序号两种段标题都跳，最终落到内容行',
      ledgerHead(多级), '真正要做的事');
  }

  // ── ⑥ 一个字段不许干两件事：headRaw 判类型，head 判内容（坑72 连带）──
  //   事故：把 head 改成「实质行」后，`查回执台账.mjs` 的 classifyOrder 立刻认不出「应答型」，
  //   23:13:44 那单（只回「收到」）从应答型掉回派单 ⇒ 立刻变未回执 + 逾期。
  {
    const 应答 = '【派单】【本单唯一指令】只回复收到，不要思考，直接回复收到\n⛔ 不要改任何文件、不要新建会话。';
    T('⑥ headRaw 保留结构标记行（判类型靠它）', /^【本单唯一指令】只回复收到/.test(ledgerHeadRaw(应答)), true);
    //   ⚠ 样本要用**占位套话**那种（内容为零的壳）：`【本单指令】按正文第一句做…`。
    //      用「唯一指令」当样本是错的 —— 那一行本身就是实质内容，两个函数相等是**对的**，
    //      断言相等就变成假红（我自己先踩了一次）。
    const 占位 = '【派单】【本单指令】按正文第一句做；⛔ 本次没标「原话：」，别把上游推测当新指令。\n⛔ 只做这一句；下面是背景与工具口径，不是新指令。\n把个人站点隐藏';
    T('⑥-a head 取实质行（判内容靠它）', ledgerHead(占位), '把个人站点隐藏');
    T('⑥-b ⛔ 反证：占位样本上两者必须不同（否则分成两个字段毫无意义）', ledgerHeadRaw(占位) === ledgerHead(占位), false);
    T('⑥-c headRaw 也剥 【派单】 前缀', /^【本单指令】/.test(ledgerHeadRaw('【派单】【本单指令】按正文第一句做')), true);
    T('⑥-d headRaw 空值不炸', ledgerHeadRaw('') + ledgerHeadRaw(null), '');
  }

  // ── ⑦ 一张单里不许有两条互斥的回执通道（2026-11-06 11:2x 真事故）──
  //   09:27 调度测试正文让场景「用 发消息.mjs --回执 交四件套」，
  //   工具尾巴又追加「■ 回执（闭环代发）…⛔ 不另跑发消息.mjs」⇒
  //   自我复盘在推理里裁决两条哪条算数（原话「conflicting instruction」），
  //   最后只在自己会话回「收到」，看板 0 条 ⇒ 假未回执。
  {
    const 作者已指定 = '【派单】调度测试\n1. 收到立刻回：node 工具\\发消息.mjs --to 命令 --回执 "【自我复盘】收到"。\n2. 随后交四件套，末行【结束】，同样走发消息.mjs --回执。';
    T('⑦-a 正文已写回执命令 ⇒ 必须判定「已带通道」（不再注入第二套）',
      正文已带回执通道(作者已指定), true);
    T('⑦-b 正文写的是 闭环.mjs --回执 ⇒ 同样算已带通道',
      正文已带回执通道('干完跑 node 工具\\闭环.mjs --场景 自我复盘 --回执 "结论…"'), true);
    T('⑦-c ⛔ 反样本：普通业务正文（没写回执命令）⇒ 必须仍允许注入',
      正文已带回执通道('结论：把 项目信息\\索引.md 的第 13-16 行改成新链接。落盘写完整路径。'), false);
    T('⑦-d ⛔ 反样本：只提到脚本名但没有 --回执 ⇒ 不算已带通道（不许夺走注入）',
      正文已带回执通道('参考 闭环.mjs 的用法，不要跑 发消息.mjs。'), false);
    T('⑦-e ⛔ 变异：若判据退化成「提到脚本名就算」，⑦-d 必然变红（证明闸真在起作用）',
      (() => { const weak = (b) => /发消息\.mjs|闭环\.mjs/.test(String(b || ''));
        return weak('参考 闭环.mjs 的用法，不要跑 发消息.mjs。') !== 正文已带回执通道('参考 闭环.mjs 的用法，不要跑 发消息.mjs。'); })(),
      true);
    T('⑦-f 空值不炸（两个 false 相加 = 0，不抛异常）', 正文已带回执通道('') + 正文已带回执通道(null), 0);
  }
  }
  }

  // ── ⑧ 16:0x 互斥裁决：能失败（拆了就红）＋ 不误伤普通单 ──
  {
    const 冲突单 = '唯一指令：在不重启整个工作台的前提下，让 /webai/ask 生效；若确实做不到，回报不可行。\n'
      + '■ 背景：main.js 主进程改动必须重启才生效，soft 热更不碰主进程。';
    const 判 = 互斥裁决(冲突单);
    T('⑧-a 冲突单 ⇒ 给出已判好的确定执行路径',
      判.includes('物理上成立') && 判.includes('不再寻找不重启路径'), true);
    T('⑧-b ⛔ 只有「不重启」没有「须重启」⇒ 不误伤',
      互斥裁决('在不重启整个工作台的前提下改渲染层逻辑'), '');
    T('⑧-c ⛔ 只有「须重启」没有「不重启」⇒ 不误伤',
      互斥裁决('main.js 改动须重启才生效，请报告宿主'), '');
    T('⑧-d ⛔ 普通办事单（含落盘 / main.js 泛词）⇒ 不误伤',
      互斥裁决('把 A 改成 B，唯一产物＝做完落盘；涉及 main.js 的配置'), '');
    T('⑧-e ⛔ 变异：把「不重启」改成「可以重启」⇒ 不再命中',
      互斥裁决(冲突单.replace('不重启整个工作台', '可以重启整个工作台')), '');
    T('⑧-f ⛔ 变异：把「重启才生效」删掉 ⇒ 不再命中',
      互斥裁决(冲突单.replace('必须重启才生效', '热更即可')), '');
    T('⑧-g 空值不炸', 互斥裁决('') + 互斥裁决(null), '');
    T('⑧-h 裁决句不含「末行【结束】」⇒ 不与回执行并列打架', !判.includes('末行【结束】'), true);
  }

  let bad = 0;
  for (const [n, got, want] of cases) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad++;
    console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : '   得到=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(want)));
  }
  console.log('\n派单 --自测：' + (cases.length - bad) + '/' + cases.length + (bad ? ' ✗ 有 ' + bad + ' 条不符' : ' ✓ 全过'));
  process.exit(bad ? 1 : 0);
}

// ══════════════════════════════════════════════════════════════════════════
// ★★ 2026-11-03 16:5x 加守卫：本文件有 `export`（TOOL_OWNER / toolOwner），
//   说明它预期会被别人 `import` 取归属表。
//   ⛔ 但 `main()` 原来是无条件调的 ⇒ 谁 import 一次，就会**真发一单**。
//   这是同一天里第三次同类事故（前两次：开工打点被 import 时跑 CLI 直接杀掉派单进程；
//   自测 IS_MAIN 恒 false 时静默 exit 0）。规矩：**有 export 的 .mjs，main 必须挂守卫**。
// ══════════════════════════════════════════════════════════════════════════
if (IS_MAIN) main().catch((e) => { console.error('✗ ' + ((e && e.message) || e)); process.exit(1); });

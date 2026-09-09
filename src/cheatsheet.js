import { db, getSetting } from './db.js';

const ZH_NOTES = {
  b1: {
    title: '第 1 步:数一数失败登录有几条(送分题)',
    boss: [
      '正确答案只有一行:FAILED: 7(数一数带 FAILED 的行:10:01:02、:07、:11、:15、:25、10:02:01、10:03:01,共 7 条)。',
      '候选人写 logs.count("FAILED") 也算满分——题目提示里就教了这个写法,考的是"会不会照提示写出能跑的代码"。',
      '数字对 → 20 分;有 FAILED: 数字 但数错 → 8 分;跑不出 → 0 分。'
    ]
  },
  b2: {
    title: '第 2 步:数一数有几种不同用户名',
    boss: [
      '正确答案:USERS: 5(admin、user、root、test、guest)。',
      '数字对 → 20 分;把重复的也算进去(数字大于 5)→ 8–12 分。',
      '这题其实在考基本功:会不会把一行按 | 切开取第 3 列、会不会用 set 去重。'
    ]
  },
  b3: {
    title: '第 3 步:哪些成功登录最可疑',
    boss: [
      '规则:同一个 IP 用同一个用户名,先失败、后来成功了 → 可疑。',
      '正确答案两行:admin | SUSPICIOUS LOGIN 和 root | SUSPICIOUS LOGIN。',
      '注意:普通用户 "user" 也有过失败和成功,但失败在 10.0.0.9、成功在 10.0.0.8(不同 IP)——不算可疑。如果候选人把 user 也报了,说明是死记硬背没理解,自动判卷会标红。',
      '解释题合格大意:"失败很多次之后成功了 = 密码被猜到/拿到,账号可能被盗"。中文回答完全可以。',
      '两个名字都对 → 12 分;解释合理 → 8 分;多报 user → 自动判卷红标,酌情扣。'
    ]
  },
  task1: {
    title: '任务一:统计每个 IP 的失败登录次数',
    boss: [
      '正确结果只有 3 行:10.0.0.5 → 6,10.0.0.8 → 0,10.0.0.9 → 1,外加一行 MOST_FAILED: 10.0.0.5。',
      '候选人代码怎么写不用看懂,只看他提交的「Answer」里有没有上面这几个数字。',
      '数字全对 → 20 分;分组对但个数错 → 10 分左右;完全不对 → 0–5 分。'
    ]
  },
  task2: {
    title: '任务二:标记可疑 IP(SUSPICIOUS / NORMAL)',
    boss: [
      '正确结果:10.0.0.5 → SUSPICIOUS;10.0.0.8 → NORMAL;10.0.0.9 → NORMAL。',
      '判断标准(规则本身就是题目要求):失败 ≥ 3 次 且 用了 ≥ 2 个不同用户名。只有 10.0.0.5 满足(失败 6 次,试了 admin/root/test/guest 共 4 个用户名)。',
      '三个结果全对 → 20 分;只对了 SUSPICIOUS 那行 → 10 分左右。'
    ]
  },
  task3: {
    title: '任务三:可疑的成功登录 + 解释原因',
    boss: [
      '正确结果两行:10.0.0.5 | admin | SUSPICIOUS SUCCESS 和 10.0.0.5 | root | SUSPICIOUS SUCCESS(10.0.0.8 的成功登录不算)。',
      '解释题的合格答案大意:「反复失败之后成功了,说明密码最终被猜到/拿到,账号可能已经被攻破」——意思对就给分,不要求原话。',
      '两行结果 + 解释合理 → 20 分;结果对解释空 → 10 分。'
    ]
  },
  followup: {
    title: '隐藏追问:IP 轮换场景(面试官手动解锁后才可见)',
    boss: [
      '标准答案:检测不到。因为新日志里每个 IP 只失败了 1 次,达不到"失败≥3"的门槛,但这明显是同一伙人在攻击同一个 admin 账号。',
      '加分回答:只按 IP 检测会被"换 IP"(IP 轮换)轻松绕过;应该按用户名 + 时间窗口 + 频率 + 行为关联来检测。',
      '只答"检测不到" → 5/15;能说出 IP 轮换绕过 → 10/15;能提出按用户名/行为维度关联 → 15/15。'
    ]
  },
  cv_verification: {
    title: 'CV 验证:核实简历上的"Flow-Level DoS 检测"项目(口头提问)',
    boss: [
      '依次问 5 个问题(页面上有原文):怎么判断流量异常?用了哪些特征?哪个特征最有用?误报怎么处理?包级和流级的区别?',
      '他做过的项目应该能说出:特征如 每秒包数/字节数/流持续时间/TCP标志 等;误报 story:正常突发流量被误判,怎么解决的。',
      '⚠️ 危险信号:讲不清自己的项目、背书式念定义、说"AI 自动检测的"、说不出数据集和实验方法 —— 有这些就往低分打。'
    ]
  },
  aiml: {
    title: 'AI/ML 理解追问(口头提问)',
    boss: [
      '问题:给这些日志做异常检测能用什么特征?只拿可疑日志训练模型行不行?',
      '合格特征:失败次数、成功次数、不同用户名数、不同 IP 数、登录频率、两次尝试间隔、单位时间事件数。',
      '训练问题的好答案:不一定只拿可疑日志;异常检测通常是给"正常行为"建基线,偏离基线的算异常。提到 Isolation Forest / One-Class SVM / Autoencoder 任一即可,不强制。',
      '特征齐全 + 基线思路 → 5 分;只说特征 → 3 分;答不上 → 0–1 分。'
    ]
  }
};

function plainText(html) {
  return String(html || '')
    .replace(/<li>/gi, '\n  • ').replace(/<\/(p|ol|ul|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderCheatsheet() {
  const assessment = db.prepare(
    "SELECT * FROM assessments WHERE is_active = 1 AND slug NOT LIKE 'python-degree-intern-%' ORDER BY id DESC LIMIT 1"
  ).get();
  if (!assessment) return '<!DOCTYPE html><html><body><p>No active assessment.</p></body></html>';
  const tasks = db.prepare('SELECT * FROM assessment_tasks WHERE assessment_id = ? ORDER BY idx').all(assessment.id);
  const sections = db.prepare('SELECT * FROM assessment_score_sections WHERE assessment_id = ? ORDER BY idx').all(assessment.id);
  const total = sections.reduce((a, s) => a + s.max_score, 0);
  const thresholds = {
    strong: Number(getSetting('threshold_strong_pass', '85')),
    pass: Number(getSetting('threshold_pass', '70')),
    review: Number(getSetting('threshold_review', '55'))
  };

  const taskCards = tasks.map(t => {
    const zh = ZH_NOTES[t.code] || { title: t.title, boss: [] };
    const blocks = [];
    if (t.answer_key) blocks.push(['✅ 正确答案(候选人输出应包含)', t.answer_key]);
    if (t.internal_answer) blocks.push(['🔍 参考解析', t.internal_answer]);
    if (t.scoring_guide) blocks.push(['📏 官方判分标准', t.scoring_guide]);
    return `
    <section class="cheat-card">
      <h2>${esc(zh.title)}${t.unlock_mode === 'admin_reveal' ? ' <span class="tag">隐藏题:仪表盘点 Reveal 后才展示给候选人</span>' : ''}${t.unlock_mode === 'never_candidate' ? ' <span class="tag">只问你问,候选人在屏幕上看不到</span>' : ''}</h2>
      ${zh.boss.length ? `<div class="boss"><b>👉 老板判分要点</b><ul>${zh.boss.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
      ${t.type !== 'interviewer_only' ? `<div class="q"><b>题目原文</b><pre>${esc(plainText(t.prompt_html))}</pre></div>` : ''}
      ${blocks.map(([label, val]) => `<div class="ans"><b>${esc(label)}</b><pre>${esc(val)}</pre></div>`).join('')}
    </section>`;
  }).join('');

  const scoreRows = sections.map(s => `<tr><td>${esc(s.label)}</td><td class="num">${s.max_score}</td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>评分手册(内部资料)— ${esc(assessment.title)}</title>
<link rel="stylesheet" href="/css/cheatsheet.css">
</head>
<body>
<div class="cheat-sheet">
  <header>
    <h1>📖 面试官评分手册 · 全部答案</h1>
    <p class="meta">${esc(assessment.title)} · 总分 ${total} 分 · 限时 ${Math.round(assessment.duration_seconds / 60)} 分钟 · 打印后仅供面试官使用,严禁给候选人</p>
  </header>

  <section class="cheat-card flow">
    <h2>🧭 流程怎么走(5 步)</h2>
    <ol>
      <li>仪表盘 <b>+ New candidate</b> 创建候选人,把弹出的用户名和一次性密码发给 TA;</li>
      <li>候选人登录 localhost:3000,自己点 <b>Start Assessment</b>,20 分钟倒计时开始;</li>
      <li>TA 连做 3 道题(做完一题才解锁下一题)。做完后界面会停在"等待面试官";</li>
      <li>你在仪表盘点 <b>Reveal to candidate</b> 解锁隐藏题(口头上让 TA 看屏幕作答),答完 TA 自己点最终提交;</li>
      <li>对照本手册逐项打分(仪表盘右侧 Scoring 区),填 0–满分,点每行的 Save;最后 <b>Finalize</b> 定稿,点 <b>Generate report</b> 出报告。</li>
    </ol>
    <p class="tip">💡 建议一边看候选人的提交,一边把本手册放在旁边对答案。CV 验证和 AI/ML 两项是口头问答,分值在仪表盘里,答案标准在本手册后半部分。</p>
  </section>

  ${taskCards}

  <section class="cheat-card">
    <h2>🧮 分数怎么合成</h2>
    <table>
      <tr><th>评分项</th><th>满分</th></tr>
      ${scoreRows}
      <tr class="total"><td>合计</td><td class="num">${total}</td></tr>
    </table>
    <p>把每项填进仪表盘的 Scoring 面板,系统自动算总分并给出建议结论:</p>
    <ul>
      <li>≥ ${thresholds.strong} 分 → <b>STRONG PASS</b>(强烈建议录用)</li>
      <li>${thresholds.pass}–${thresholds.strong - 1} 分 → <b>PASS</b>(通过)</li>
      <li>${thresholds.review}–${thresholds.pass - 1} 分 → <b>REVIEW</b>(再加一轮面试)</li>
      <li>&lt; ${thresholds.review} 分 → <b>FAIL</b>(不通过)</li>
    </ul>
    <p class="tip">💡 分数只是参考:如果"诚信指标"面板出现"大段粘贴 / 秒交但解释讲不清"等信号,口头追问代码含义;答不上就按低分处理。最终结论以你的判断为准,Finalize 时可以手动改推荐结论。</p>
  </section>

  <footer>内部机密 — 仅限面试官 · 生成于 ${new Date().toLocaleString('zh-CN')}</footer>
</div>
</body>
</html>`;
}

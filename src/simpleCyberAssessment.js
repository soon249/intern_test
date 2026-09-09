import { db, now } from './db.js';

const LOG_DATA = `10:01:02 | 10.0.0.5  | admin | FAILED
10:01:05 | 10.0.0.8  | user  | SUCCESS
10:01:07 | 10.0.0.5  | admin | FAILED
10:01:11 | 10.0.0.5  | root  | FAILED
10:01:15 | 10.0.0.5  | test  | FAILED
10:01:19 | 10.0.0.5  | admin | SUCCESS
10:01:25 | 10.0.0.9  | user  | FAILED
10:02:01 | 10.0.0.5  | root  | FAILED
10:02:10 | 10.0.0.5  | root  | SUCCESS
10:02:15 | 10.0.0.8  | user  | SUCCESS
10:03:01 | 10.0.0.5  | guest | FAILED`;

const STARTER = (todo) => `logs = """
${LOG_DATA}
"""

# ${todo}
`;

export const BASIC_SLUG = 'cybersec-intern-basic';

/**
 * "Basic" edition of the cybersecurity screen — same log, same security story,
 * but every task is solvable with elementary Python (string counting / simple
 * loops). Even a candidate who studies the model answers can reproduce them.
 * New candidates are assigned to this assessment; any assessment created with
 * the original (harder) 'cybersec-intern-test' slug is deactivated, while its
 * in-flight sessions keep working (session lookups do not filter on is_active).
 */
export function ensureSimpleCyberSeed() {
  const existing = db.prepare('SELECT id FROM assessments WHERE slug = ?').get(BASIC_SLUG);
  if (existing) return existing.id;

  const t = now();

  const assessment = db.prepare(
    `INSERT INTO assessments (slug, title, description, instructions, duration_seconds, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(
    BASIC_SLUG,
    'Cybersecurity Intern Test (Basic)',
    'Beginner-friendly 20-minute screen: 3 very simple Python tasks on an authentication log.',
    JSON.stringify({
      intro: [
        'This assessment lasts 20 minutes. A single countdown timer runs for the entire assessment.',
        'Three very simple tasks. The next one unlocks only after you submit the current one.',
        'Every task gives you a hint — read it before writing code.',
        'Your code is auto-saved. Press Submit when your output matches the requested format.',
        'After Task 3 your interviewer may unlock one short follow-up question.'
      ]
    }),
    20 * 60,
    t
  );
  const assessmentId = assessment.lastInsertRowid;

  // retire the harder edition for NEW sessions
  db.prepare("UPDATE assessments SET is_active = 0 WHERE slug = 'cybersec-intern-test' AND id != ?").run(assessmentId);

  const insertTask = db.prepare(
    `INSERT INTO assessment_tasks
       (assessment_id, idx, code, title, type, prompt_html, data_text, starter_code,
        explanation_required, code_editor, answer_key, scoring_guide, internal_answer, unlock_mode, max_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // ---- b1: count FAILED lines ----
  insertTask.run(
    assessmentId, 0, 'b1',
    'Step 1 — Count the failed logins(数一数失败登录)',
    'code',
    `<p>The log below records login attempts.</p>
     <p><b>Task:</b> print <b>one line</b>: how many lines have the status <b>FAILED</b>, in the format <code>FAILED: &lt;number&gt;</code>.</p>
     <p class="muted">提示:Python 里 <code>logs.count("FAILED")</code> 直接就是答案——一行代码就够。</p>`,
    LOG_DATA,
    STARTER('TODO: print the number of FAILED lines, like  FAILED: 7'),
    0, 1,
    'FAILED: 7',
    'Output line correct (FAILED: 7): 20. Wrong number but a FAILED: <n> line present: 8. Nothing runnable: 0.',
    '7 lines contain FAILED: five from 10.0.0.5 (10:01:02, :07, :11, :15, 10:02:01), one from 10.0.0.9 (10:01:25) and one more from 10.0.0.5 (10:03:01, guest). logs.count("FAILED") == 7.',
    'after_previous', 20
  );

  // ---- b2: distinct usernames ----
  insertTask.run(
    assessmentId, 1, 'b2',
    'Step 2 — How many different usernames(有几种不同用户名)',
    'code',
    `<p>Same log. Attackers often try many accounts.</p>
     <p><b>Task:</b> print <b>one line</b>: how many <b>different usernames</b> appear in the whole log, in the format <code>USERS: &lt;number&gt;</code>.</p>
     <p class="muted">提示:每行用 <code>|</code> 分成 4 列,第 3 列是用户名;把用户名放进一个 <code>set</code>,最后 <code>len()</code> 一下。</p>`,
    LOG_DATA,
    STARTER('TODO: print the number of DIFFERENT usernames, like  USERS: 9'),
    0, 1,
    'USERS: 5  (admin, user, root, test, guest)',
    'USERS: 5 correct: 20. Off-by-one or counting duplicates: 8–12. No runnable code: 0.',
    'admin, user, root, test, guest → 5 distinct usernames. The attacker IP 10.0.0.5 alone tried 4 of them.',
    'after_previous', 20
  );

  // ---- b3: suspicious successful logins ----
  insertTask.run(
    assessmentId, 2, 'b3',
    'Step 3 — Suspicious successful logins(哪些成功登录最可疑)',
    'code',
    `<p>Same log. The attacker at one IP tried several accounts before getting in.</p>
     <p><b>Task:</b> a successful login is <b>suspicious</b> when the <b>same IP + same username</b> had a <b>FAILED</b> attempt earlier in the log. Print one line for each such successful login, in the format <code>&lt;username&gt; | SUSPICIOUS LOGIN</code>.</p>
     <p class="muted">提示:先收集所有 FAILED 行的 (IP, 用户名),再看每个 SUCCESS 行的 (IP, 用户名) 是否在里面。</p>
     <p>You must also answer in the explanation box: <b>why is a success after failures worse than a normal failed login?</b> (中文也可以)</p>`,
    LOG_DATA,
    STARTER('TODO: print  <username> | SUSPICIOUS LOGIN  for each suspicious success'),
    1, 1,
    'admin | SUSPICIOUS LOGIN\nroot | SUSPICIOUS LOGIN\n(Explanation: repeated failures followed by a success mean the password was eventually guessed/obtained — likely account compromise.)',
    'Both usernames printed in format: 12. One username: 6. Explanation mentions credential guessing/compromise: 8. No explanation: −8. Flagging plain "user" is a false positive (its failure was a different IP) — that is what the auto-checker penalises.',
    '10.0.0.5: admin 4× FAILED then SUCCESS; root FAILED then SUCCESS — both suspicious. The user account DID succeed (10.0.0.8) but its FAILED was from a different IP (10.0.0.9) — normal user, not suspicious.',
    'after_previous', 20
  );

  // ---- hidden follow-up (kept conceptual, no coding) ----
  insertTask.run(
    assessmentId, 3, 'followup',
    'Hidden Follow-up — IP Rotation Scenario',
    'scenario',
    `<p>Your interviewer shows you a new log captured minutes later:</p>
     <p><b>Question 1:</b> Would the "count the failed logins" idea from Step 1 detect this attack?</p>
     <p><b>Question 2:</b> What is weak about looking at each IP on its own?</p>
     <p><b>Question 3:</b> What would you change?</p>`,
    `10:01:02 | 10.0.0.5 | admin | FAILED
10:01:05 | 10.0.0.6 | admin | FAILED
10:01:08 | 10.0.0.7 | admin | FAILED
10:01:11 | 10.0.0.8 | admin | FAILED
10:01:14 | 10.0.0.9 | admin | SUCCESS`,
    null,
    1, 0,
    null,
    'Basic (5/15): "No — each IP failed only once." Better (10/15): names IP rotation as a way to bypass per-IP counting. Strong (15/15): proposes correlating username / time window / frequency / behaviour.',
    'No — every IP has exactly one failure, so a simple count per IP never triggers even though the admin account is clearly under attack. Correlate by username and behaviour, not IP alone.',
    'admin_reveal', 15
  );

  // ---- interviewer-only sections (same as standard edition) ----
  insertTask.run(
    assessmentId, 4, 'cv_verification',
    'CV Verification — Flow-Level DoS Detection',
    'interviewer_only',
    `<p>Ask verbally. The CV claims: <i>"Flow-Level DoS Attack Detection and Mitigation under Benign Burst Traffic"</i></p>
     <ol>
       <li>Explain how you determined that a traffic flow was abnormal.</li>
       <li>What features did you use?</li>
       <li>Which feature was the most useful and why?</li>
       <li>How did you deal with false positives?</li>
       <li>What is the difference between packet-level and flow-level analysis?</li>
     </ol>`,
    null, null, 0, 0,
    null,
    'Legitimate features: flow duration, packet/byte count, per-second rates, IPs, ports, TCP flags, connection frequency. Score on whether they can explain THEIR OWN project, feature choice, false positives and methodology. RED FLAGS: recites definitions, "AI did it", no dataset/method story.',
    'A genuine author describes flow features (packets/bytes per second, duration, SYN counts), a threshold or model, and a concrete false-positive story (benign burst traffic).',
    'never_candidate', 20
  );

  insertTask.run(
    assessmentId, 5, 'aiml',
    'AI/ML Understanding Follow-up',
    'interviewer_only',
    `<p>Ask verbally:</p>
     <ol>
       <li>What features could an anomaly-detection system use on these logs?</li>
       <li>Would you train it using only suspicious logs?</li>
     </ol>`,
    null, null, 0, 0,
    null,
    'Features: failed/success counts, distinct usernames, distinct IPs, frequency, inter-attempt time. Training: strong answer says "not necessarily — model NORMAL behaviour and flag deviations"; algorithms optional (Isolation Forest, One-Class SVM, Autoencoder).',
    '5 = features + normal-baseline reasoning; 3 = features only; 1 = vague; 0 = none.',
    'never_candidate', 5
  );

  // ---- score sections (100 total) ----
  const insertSection = db.prepare(
    'INSERT INTO assessment_score_sections (assessment_id, code, label, max_score, idx) VALUES (?, ?, ?, ?, ?)'
  );
  insertSection.run(assessmentId, 'TASK_1', 'Step 1 — Count failed logins', 20, 0);
  insertSection.run(assessmentId, 'TASK_2', 'Step 2 — Distinct usernames', 20, 1);
  insertSection.run(assessmentId, 'TASK_3', 'Step 3 — Suspicious successes', 20, 2);
  insertSection.run(assessmentId, 'FOLLOWUP', 'Hidden Scenario — IP Rotation', 15, 3);
  insertSection.run(assessmentId, 'CV_VERIFICATION', 'CV Verification', 20, 4);
  insertSection.run(assessmentId, 'AI_ML', 'AI/ML Understanding', 5, 5);

  return assessmentId;
}

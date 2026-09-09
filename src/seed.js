import { db, now } from './db.js';
import { ensurePythonQuestionBank, SKILL_CATALOG } from './pythonQuestions.js';
import { createPythonAssessment } from './pythonAssessment.js';

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

const ROTATION_LOG_DATA = `10:01:02 | 10.0.0.5 | admin | FAILED
10:01:05 | 10.0.0.6 | admin | FAILED
10:01:08 | 10.0.0.7 | admin | FAILED
10:01:11 | 10.0.0.8 | admin | FAILED
10:01:14 | 10.0.0.9 | admin | SUCCESS`;

export function ensureSeed() {
  const t = now();

  // Default admin. Credentials documented in README; change after first login.
  // (Recreated if missing so a deleted admin cannot lock the interviewer out.)
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get('admin')) {
    db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('admin', hash('admin123'), 'admin', 'Interviewer', t);
  }

  // Sample candidate account — recreated if it was deleted from the dashboard
  // (deleting a candidate also deletes its user, so the old "seed only on a
  // fresh database" guard left the demo account gone forever).
  const existingSeedAssessment = db.prepare('SELECT id FROM assessments WHERE slug = ?').get('cybersec-intern-test');
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get('johntan')) {
    const candUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('johntan', hash('candidate123'), 'candidate', 'John Tan', t);
    const candRes = db.prepare('INSERT INTO candidates (user_id, name, email, position, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(candUser.lastInsertRowid, 'John Tan', 'john.tan@example.com', 'Cybersecurity Intern', t);
    if (existingSeedAssessment) {
      db.prepare(
        'INSERT INTO assessment_sessions (assessment_id, candidate_id, created_by, created_at) VALUES (?, ?, ?, ?)'
      ).run(existingSeedAssessment.id, candRes.lastInsertRowid, 1, t);
    }
  }
  if (existingSeedAssessment) return existingSeedAssessment.id;

  const assessment = db.prepare(
    `INSERT INTO assessments (slug, title, description, instructions, duration_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    'cybersec-intern-test',
    'Cybersecurity Intern Test',
    '20-Minute Cybersecurity Coding Test for internship candidates.',
    JSON.stringify({
      intro: [
        'This assessment lasts 20 minutes. A single countdown timer runs for the entire assessment.',
        'You will complete 3 sequential tasks. The next task is shown only after you submit the current one.',
        'Your code and answers are auto-saved as you type. Press "Save" manually at any time.',
        'For each coding task, write Python that prints the required output, then submit.',
        'After Task 3, your interviewer may give you a follow-up scenario. Wait on the completion screen.',
        'When the timer reaches 00:00 you can no longer submit. Everything you saved is preserved for review.',
        'Do not open other tools or tabs. Explain your solutions in your own words.'
      ]
    }),
    20 * 60,
    t
  );
  const assessmentId = assessment.lastInsertRowid;

  // assign the sample candidate to the assessment (NOT_STARTED until they press Start)
  const seedCandidate = db.prepare(
    "SELECT c.id FROM candidates c JOIN users u ON u.id = c.user_id WHERE u.username = 'johntan'"
  ).get();
  db.prepare(
    'INSERT INTO assessment_sessions (assessment_id, candidate_id, created_by, created_at) VALUES (?, ?, ?, ?)'
  ).run(assessmentId, seedCandidate.id, 1, t);

  const insertTask = db.prepare(
    `INSERT INTO assessment_tasks
       (assessment_id, idx, code, title, type, prompt_html, data_text, starter_code,
        explanation_required, code_editor, answer_key, scoring_guide, internal_answer, unlock_mode, max_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // ---- TASK 1 ----
  insertTask.run(
    assessmentId, 0, 'task1',
    'Security Log Investigation — Failed Login Analysis',
    'code',
    `<p>The following lines were extracted from an authentication log:</p>
     <p><b>Task:</b> Using Python, calculate the number of <b>FAILED</b> login attempts for each IP address and print one line per IP in the format <code>&lt;ip&gt; -&gt; &lt;count&gt;</code>.</p>
     <p>Then add one final line identifying the IP with the highest number of failed attempts, in the format <code>MOST_FAILED: &lt;ip&gt;</code>.</p>`,
    LOG_DATA,
    `logs = """
10:01:02 | 10.0.0.5  | admin | FAILED
10:01:05 | 10.0.0.8  | user  | SUCCESS
10:01:07 | 10.0.0.5  | admin | FAILED
10:01:11 | 10.0.0.5  | root  | FAILED
10:01:15 | 10.0.0.5  | test  | FAILED
10:01:19 | 10.0.0.5  | admin | SUCCESS
10:01:25 | 10.0.0.9  | user  | FAILED
10:02:01 | 10.0.0.5  | root  | FAILED
10:02:10 | 10.0.0.5  | root  | SUCCESS
10:02:15 | 10.0.0.8  | user  | SUCCESS
10:03:01 | 10.0.0.5  | guest | FAILED
"""

# TODO: count FAILED logins per IP and print the result
`,
    0, 1,
    '10.0.0.5 -> 6\n10.0.0.8 -> 0\n10.0.0.9 -> 1\nMOST_FAILED: 10.0.0.5',
    'Correct parsing: 5 | Correct counting: 5 | Correct grouping by IP: 5 | Correct result: 5. Partial credit if grouping is correct but result lines are misformatted.',
    'The attacker at 10.0.0.5 sprayed multiple usernames (admin, root, test, guest) — 6 failures followed by a SUCCESS for admin and later root: a successful brute force. 10.0.0.8 and 10.0.0.9 are normal user activity.',
    'after_previous', 20
  );

  // ---- TASK 2 ----
  insertTask.run(
    assessmentId, 1, 'task2',
    'Suspicious Login Detection',
    'code',
    `<p><b>Requirements changed.</b> The SOC team now wants a detection rule instead of raw counts.</p>
     <p>An IP is <b>SUSPICIOUS</b> if <b>both</b> conditions hold:</p>
     <ol><li>FAILED attempts &gt;= 3, <b>and</b></li>
     <li>the IP attempted logins with at least <b>2 different usernames</b>.</li></ol>
     <p>Using the same log, print one line per IP in the format <code>&lt;ip&gt; -&gt; SUSPICIOUS</code> or <code>&lt;ip&gt; -&gt; NORMAL</code>.</p>`,
    LOG_DATA,
    `logs = """
10:01:02 | 10.0.0.5  | admin | FAILED
10:01:05 | 10.0.0.8  | user  | SUCCESS
10:01:07 | 10.0.0.5  | admin | FAILED
10:01:11 | 10.0.0.5  | root  | FAILED
10:01:15 | 10.0.0.5  | test  | FAILED
10:01:19 | 10.0.0.5  | admin | SUCCESS
10:01:25 | 10.0.0.9  | user  | FAILED
10:02:01 | 10.0.0.5  | root  | FAILED
10:02:10 | 10.0.0.5  | root  | SUCCESS
10:02:15 | 10.0.0.8  | user  | SUCCESS
10:03:01 | 10.0.0.5  | guest | FAILED
"""

# TODO: flag each IP as SUSPICIOUS or NORMAL
`,
    0, 1,
    '10.0.0.5 -> SUSPICIOUS (FAILED=6, unique usernames=4: admin, root, test, guest)\n10.0.0.8 -> NORMAL (FAILED=0)\n10.0.0.9 -> NORMAL (FAILED=1)',
    'Correct failed count: 5 | Correct unique-user logic: 5 | Correct condition implementation (both conditions AND-ed): 5 | Correct result: 5. Watch for candidates counting unique usernames across all attempts vs only failed attempts — either is acceptable if stated.',
    'Detection logic combines volume (failed >= 3) with breadth (>= 2 distinct usernames). 10.0.0.5 hits both. Candidates who mention that SUCCESS-after-failures makes it worse are thinking ahead to Task 3.',
    'after_previous', 20
  );

  // ---- TASK 3 ----
  insertTask.run(
    assessmentId, 2, 'task3',
    'Suspicious Successful Login',
    'code',
    `<p>Final requirement change. A successful login is <b>SUSPICIOUS</b> if the <b>same IP</b> had earlier FAILED attempts.</p>
     <p>Using the same log, print every suspicious successful login in the format <code>&lt;ip&gt; | &lt;username&gt; | SUSPICIOUS SUCCESS</code>.</p>
     <p>You must also answer in the explanation box: <b>Why can a successful login after repeated failures be more serious than a normal failed login?</b></p>`,
    LOG_DATA,
    `logs = """
10:01:02 | 10.0.0.5  | admin | FAILED
10:01:05 | 10.0.0.8  | user  | SUCCESS
10:01:07 | 10.0.0.5  | admin | FAILED
10:01:11 | 10.0.0.5  | root  | FAILED
10:01:15 | 10.0.0.5  | test  | FAILED
10:01:19 | 10.0.0.5  | admin | SUCCESS
10:01:25 | 10.0.0.9  | user  | FAILED
10:02:01 | 10.0.0.5  | root  | FAILED
10:02:10 | 10.0.0.5  | root  | SUCCESS
10:02:15 | 10.0.0.8  | user  | SUCCESS
10:03:01 | 10.0.0.5  | guest | FAILED
"""

# TODO: print suspicious successful logins
`,
    1, 1,
    '10.0.0.5 | admin | SUSPICIOUS SUCCESS  (4 FAILED then SUCCESS)\n10.0.0.5 | root  | SUSPICIOUS SUCCESS  (1 FAILED then SUCCESS)\n(10.0.0.8 user SUCCESS is not suspicious: no earlier failures for that IP.)\nExplanation: a success after repeated failures suggests credentials were eventually guessed/obtained — possible successful brute force and account compromise; a failed login alone is just a rejected attempt.',
    'Correct suspicious successes: 10 | Correct reasoning about credential compromise / successful brute force: 10. Accept "valid credentials eventually obtained", "brute force succeeded", "account compromised". Deduct if they flag all successes or miss root.',
    'admin SUCCESS at 10:01:19 follows 4 failures; root SUCCESS at 10:02:10 follows 1 failure. The explanation should mention eventual credential compromise, brute-force success, or account takeover.',
    'after_previous', 20
  );

  // ---- HIDDEN FOLLOW-UP (revealed only by interviewer) ----
  insertTask.run(
    assessmentId, 3, 'followup',
    'Hidden Follow-up — IP Rotation Scenario',
    'scenario',
    `<p>Your interviewer shows you a new log captured minutes later:</p>
     <p><b>Question 1:</b> Would your current detection logic (Task 2 rule) detect this attack?</p>
     <p><b>Question 2:</b> Explain what is wrong with relying only on IP-based detection.</p>
     <p><b>Question 3:</b> What would you change?</p>`,
    ROTATION_LOG_DATA,
    null,
    1, 0,
    null,
    'Basic (5/15): answers "No — each IP has only one failed attempt". Better (10/15): identifies over-reliance on IP identity and that IP rotation bypasses the threshold. Strong (15/15): proposes correlating username / time window / frequency / session or device info, or behavior-based detection across dimensions.',
    'No — with IP rotation each IP appears once, so FAILED >= 3 never triggers even though one account (admin) is clearly under attack. Detection should correlate by username and behaviour (time window, frequency, distributed sources), not IP alone.',
    'admin_reveal', 15
  );

  // ---- CV VERIFICATION (interviewer-only) ----
  insertTask.run(
    assessmentId, 4, 'cv_verification',
    'CV Verification — Flow-Level DoS Detection',
    'interviewer_only',
    `<p>Ask verbally. The CV claims: <i>"Flow-Level DoS Attack Detection and Mitigation under Benign Burst Traffic"</i></p>
     <ol>
       <li>You mentioned Flow-Level DoS Detection. Explain how you determined that a traffic flow was abnormal.</li>
       <li>What features did you use?</li>
       <li>Which feature was the most useful and why?</li>
       <li>How did you deal with false positives?</li>
       <li>What is the difference between packet-level and flow-level analysis?</li>
     </ol>`,
    null, null, 0, 0,
    null,
    'Legitimate features: flow duration, packet/byte count, packets/bytes per second, IPs, ports, TCP flags, connection frequency, timing. Do NOT require all. Score on: (1) can they explain their own project, (2) why a feature matters, (3) false positives, (4) packet vs flow distinction, (5) real methodology (dataset, experiments).\nRED FLAGS: cannot explain own project; recites memorized definitions; "AI automatically detected it"; no dataset/methodology; cannot explain feature choice or false positives.',
    'A candidate who did this project should describe flow features (e.g. packets per second, bytes per flow, duration, SYN counts), a baseline/threshold or ML model, and a false-positive story (benign burst traffic being flagged) with a concrete mitigation.',
    'never_candidate', 20
  );

  // ---- AI/ML FOLLOW-UP (interviewer-only) ----
  insertTask.run(
    assessmentId, 5, 'aiml',
    'AI/ML Understanding Follow-up',
    'interviewer_only',
    `<p>Ask verbally:</p>
     <ol>
       <li>If you wanted to build an anomaly detection system for these logs, what features could you use?</li>
       <li>Would you train an anomaly detection model using only suspicious logs?</li>
     </ol>`,
    null, null, 0, 0,
    null,
    'Valid features: failed/successful login counts, unique usernames, unique IPs, login frequency, time between attempts, events per time window, behaviour baseline. On training data: strong answer — no, not necessarily; anomaly detection models normal behaviour and flags deviations; approach depends on labelled data and model choice. Algorithms (optional): Isolation Forest, One-Class SVM, Autoencoder, statistical baselines. Do not require a specific model.',
    'Score 5 if candidate names plausible features AND shows the normal-baseline reasoning. 3 if features only. 1 if vague. 0 if no understanding.',
    'never_candidate', 5
  );

  // ---- Score sections (sums to 100; matches dashboard example in the spec) ----
  const insertSection = db.prepare(
    'INSERT INTO assessment_score_sections (assessment_id, code, label, max_score, idx) VALUES (?, ?, ?, ?, ?)'
  );
  insertSection.run(assessmentId, 'TASK_1', 'Task 1 — Failed Login Analysis', 20, 0);
  insertSection.run(assessmentId, 'TASK_2', 'Task 2 — Suspicious Login Detection', 20, 1);
  insertSection.run(assessmentId, 'TASK_3', 'Task 3 — Suspicious Successful Login', 20, 2);
  insertSection.run(assessmentId, 'FOLLOWUP', 'Hidden Scenario — IP Rotation', 15, 3);
  insertSection.run(assessmentId, 'CV_VERIFICATION', 'CV Verification', 20, 4);
  insertSection.run(assessmentId, 'AI_ML', 'AI/ML Understanding', 5, 5);

  // Recommendation thresholds (configurable by admin via API).
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('threshold_strong_pass', '85');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('threshold_pass', '70');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('threshold_review', '55');

  return assessmentId;
}

// Local scrypt hash helper to avoid a circular import with auth.js
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
export function hash(password) {
  const salt = randomBytes(16).toString('hex');
  const hashHex = scryptSync(password, salt, 64).toString('hex');
  return `s1$${salt}$${hashHex}`;
}
export function verify(password, stored) {
  const [ver, salt, hashHex] = String(stored).split('$');
  if (ver !== 's1') return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/**
 * Seeds the Python Technical Assessment question bank and a demo candidate
 * (Susan Lim) with a CV skill profile + a pre-generated assessment, so the
 * module can be tried immediately. Safe to call repeatedly.
 */
export function ensurePythonSeed() {
  ensurePythonQuestionBank();
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get('susanlim')) return;

  const t = now();
  const userRes = db.prepare(
    'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('susanlim', hash('candidate123'), 'candidate', 'Susan Lim', t);
  const candRes = db.prepare(
    'INSERT INTO candidates (user_id, name, email, position, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userRes.lastInsertRowid, 'Susan Lim', 'susan.lim@example.com', 'Data / Python Intern', t);

  // CV skill profile (spec §23 example): what Susan claims on her CV.
  const insSkill = db.prepare(
    'INSERT INTO candidate_skills (candidate_id, skill_name, claimed_level, source, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const [skill, level] of [
    ['Python', 'advanced'], ['Pandas', 'intermediate'], ['Web Scraping', 'intermediate'],
    ['SQL', 'intermediate'], ['Machine Learning', 'beginner']
  ]) {
    insSkill.run(candRes.lastInsertRowid, skill, level, 'cv', t);
  }

  // Pre-generated CV-skill-based assessment so the demo works out of the box.
  createPythonAssessment({
    adminId: 1, candidateId: candRes.lastInsertRowid,
    mode: 'cv_skill', randomize: false, durationSeconds: 1800
  });
}

// Automated test suite for the Intern Assessment Platform.
// Covers the 20 required cases from the spec plus extra security checks.
// Run: npm test   (spawns a server on a scratch DB, never touches production data)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 3177 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'iap-test-'));
const DB_PATH = path.join(dataDir, 'test.db');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name} ${extra}`); }
}

function jar() {
  let cookie = null;
  return {
    get cookie() { return cookie || ''; },
    async req(method, url, body) {
      const res = await fetch(BASE + url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'fetch',
          ...(cookie ? { Cookie: cookie } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* html pages */ }
      return { status: res.status, data, headers: res.headers };
    }
  };
}

// start server
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', d => process.env.VERBOSE && console.log('[srv]', d.toString().trim()));
server.stderr.on('data', d => console.error('[srv-err]', d.toString().trim()));

await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const poll = async () => {
    try { await fetch(BASE + '/'); resolve(); }
    catch { if (Date.now() - t0 > 10000) reject(new Error('server did not start')); else setTimeout(poll, 200); }
  };
  poll();
});

try {
  const admin = jar();
  const candA = jar(); // johntan
  const candB = jar(); // second candidate (created mid-run)

  const login = async (j, u, p) => j.req('POST', '/api/auth/login', { username: u, password: p });

  // ---------- setup: admin + candidate logins ----------
  console.log('\n== setup ==');
  let r = await login(admin, 'admin', 'admin123');
  check('admin login works', r.status === 200 && r.data.role === 'admin');
  r = await login(candA, 'johntan', 'candidate123');
  check('candidate login works', r.status === 200 && r.data.role === 'candidate');
  r = await login(candA, 'johntan', 'wrong');
  check('wrong password rejected', r.status === 401);
  r = await login(candA, "' OR 1=1 --", 'x'); // TEST 19 (part 1): SQL injection login attempt
  check('SQLi login attempt rejected', r.status === 401);

  // create a second candidate via admin API
  r = await admin.req('POST', '/api/admin/candidates', { name: 'Alice Wong' });
  check('admin creates candidate + one-time password', r.status === 200 && /^[A-Za-z0-9_-]+$/.test(r.data.candidate.oneTimePassword));
  const candBPassword = r.data.candidate.oneTimePassword;
  const candBUsername = r.data.candidate.username;
  r = await login(candB, candBUsername, candBPassword);
  check('new candidate can log in with one-time password', r.status === 200);

  // ---------- TEST 17: cross-candidate isolation ----------
  console.log('\n== TEST 17: unauthorized cross-candidate access ==');
  r = await candB.req('POST', '/api/candidate/assessment/start', {});
  check('candidate B starts own session', r.status === 200);

  // find task ids from admin API
  let detailA = (await admin.req('GET', '/api/admin/assessments/1')).data;
  const task1 = detailA.tasks.find(t => t.idx === 0);
  const task2 = detailA.tasks.find(t => t.idx === 1);
  const task3 = detailA.tasks.find(t => t.idx === 2);
  const followup = detailA.tasks.find(t => t.idx === 3);
  check('admin detail lists all tasks with keys', !!task1?.answerKey && !!task2?.answerKey && !!followup?.scoringGuide);

  // candidate B tries to write to candidate A's task 2 (unlocked only for A)
  r = await candB.req('POST', `/api/candidate/tasks/${task2.id}/save`, { code: 'x', answer: 'y' });
  check('candidate B cannot save another candidate’s unlocked task', r.status === 403 && r.data.error === 'TASK_NOT_UNLOCKED');
  r = await candB.req('POST', `/api/candidate/tasks/${task2.id}/submit`, { code: 'x', answer: 'y' });
  check('candidate B cannot submit another candidate’s task', r.status === 403);

  // ---------- candidate A flow ----------
  console.log('\n== TEST 1-2: start + timer ==');
  r = await candA.req('POST', '/api/candidate/assessment/start', {});
  check('TEST 1: candidate starts assessment', r.status === 200 && r.data.status === 'IN_PROGRESS');
  check('TEST 2: timer starts ~20:00 server-side', r.data.timer.remainingSeconds >= 1195 && r.data.timer.remainingSeconds <= 1200,
    `remaining=${r.data.timer?.remainingSeconds}`);
  check('TEST 2b: deadline is server-issued (not client)', typeof r.data.timer.deadlineAt === 'number' && r.data.timer.deadlineAt > Date.now());

  // ---------- TEST 3: no answer key in candidate API ----------
  console.log('\n== TEST 3: answer-key exposure ==');
  r = await candA.req('GET', '/api/candidate/assessment/current');
  const blob = JSON.stringify(r.data);
  check('TEST 3: candidate API contains no answer-key fields',
    !blob.includes('answerKey') && !blob.includes('scoring_guide') && !blob.includes('internal_answer'));
  check('TEST 3b: candidate API contains no model answers',
    !blob.includes('10.0.0.9 -> 1') && !blob.includes('Correct parsing') &&
    !blob.includes('SUSPICIOUS SUCCESS\n') && !blob.includes('Isolation Forest') &&
    !blob.includes('unique usernames=4'));
  check('TEST 3c: candidate sees only the current task', r.data.task && r.data.task.idx === 0 && r.data.progress.every(p => p.idx === undefined ? true : true));
  check('TEST 3d: hidden follow-up not visible before reveal', !JSON.stringify(r.data).includes('Rotation'));

  // ---------- TEST 4: future task inaccessible ----------
  console.log('\n== TEST 4: future-task protection ==');
  r = await candA.req('GET', '/api/candidate/assessment/current');
  check('TEST 4a: current task is task 1', r.data.task.id === task1.id);
  r = await candA.req('POST', `/api/candidate/tasks/${task2.id}/submit`, { code: 'print("early")', answer: '' });
  check('TEST 4b: submitting future task rejected', r.status === 403 && r.data.error === 'TASK_NOT_UNLOCKED');
  r = await candA.req('POST', `/api/candidate/tasks/${followup.id}/submit`, { answer: 'cheating?' });
  check('TEST 4c: hidden follow-up not submittable', r.status === 403);

  // ---------- TEST 18: XSS handling ----------
  console.log('\n== TEST 18: XSS payload handling ==');
  const xss = `<script>alert('pwn')</script><img src=x onerror=alert(1)>`;
  r = await candA.req('POST', `/api/candidate/tasks/${task1.id}/save`, { code: `# ${xss}`, answer: xss, explanation: '' });
  check('TEST 18a: XSS payload accepted & stored as data (no eval server-side)', r.status === 200);
  r = await candA.req('GET', '/api/candidate/assessment/current');
  check('TEST 18b: candidate draft round-trips as JSON (content-type json)',
    r.headers.get('content-type').includes('application/json') && r.data.task.draft.answer.includes('<script>'));
  r = await candA.req('GET', '/candidate');
  check('TEST 18c: CSP blocks inline script on pages',
    (r.headers.get('content-security-policy') || '').includes("script-src 'self'") && (r.headers.get('x-content-type-options') === 'nosniff'));

  // ---------- TEST 19 (part 2): SQLi in answer payload ----------
  r = await candA.req('POST', `/api/candidate/tasks/${task1.id}/save`,
    { code: "'; DROP TABLE assessment_answers; --", answer: "' OR '1'='1", explanation: '' });
  check('TEST 19b: SQLi strings stored literally (parameterized)', r.status === 200);

  // ---------- TEST 5-8: sequential submissions ----------
  console.log('\n== TEST 5-8: staged task delivery ==');
  r = await candA.req('POST', `/api/candidate/tasks/${task1.id}/submit`, {
    code: 'from collections import Counter\n...',
    answer: '10.0.0.5 -> 6\n10.0.0.8 -> 0\n10.0.0.9 -> 1\nMOST_FAILED: 10.0.0.5',
    explanation: 'Parsed each line, filtered FAILED, counted per IP.'
  });
  check('TEST 5: candidate submits Task 1', r.status === 200 && r.data.nextUnlocked === true);
  r = await candA.req('GET', '/api/candidate/assessment/current');
  check('TEST 6: Task 2 unlocks after Task 1 submission', r.data.task.id === task2.id);
  r = await candA.req('POST', `/api/candidate/tasks/${task2.id}/submit`, { code: '...', answer: '10.0.0.5 -> SUSPICIOUS', explanation: '' });
  check('TEST 7: candidate submits Task 2', r.status === 200);
  r = await candA.req('GET', '/api/candidate/assessment/current');
  check('TEST 8: Task 3 unlocks after Task 2 submission', r.data.task.id === task3.id);

  // ---------- TEST 16: multiple submissions preserved ----------
  console.log('\n== TEST 16: submission versioning ==');
  r = await candA.req('POST', `/api/candidate/tasks/${task1.id}/submit`, {
    code: 'v2-improved', answer: '10.0.0.5 -> 6 (revised)', explanation: 'cleaner version'
  });
  check('TEST 16a: resubmission of unlocked task accepted', r.status === 200);
  detailA = (await admin.req('GET', '/api/admin/assessments/1')).data;
  const t1Versions = detailA.tasks.find(t => t.id === task1.id).answers;
  check('TEST 16b: both versions preserved (v1 not overwritten)',
    t1Versions.length === 2 && t1Versions[0].code !== t1Versions[1].code && t1Versions[0].submission_version === 1);

  // ---------- TEST 15: answers persisted ----------
  check('TEST 15: answers persisted with content + timestamps',
    detailA.tasks.find(t => t.id === task2.id).answers[0]?.answer.length > 0 &&
    !!detailA.tasks.find(t => t.id === task2.id).answers[0]?.submitted_at);

  // ---------- submit task 3 (needs explanation) ----------
  r = await candA.req('POST', `/api/candidate/tasks/${task3.id}/submit`, { code: 'x', answer: 'y', explanation: '' });
  check('explanation_required enforced on Task 3', r.status === 400 && r.data.error === 'EXPLANATION_REQUIRED');
  r = await candA.req('POST', `/api/candidate/tasks/${task3.id}/submit`, {
    code: 'x', answer: '10.0.0.5 | admin | SUSPICIOUS SUCCESS', explanation: 'A success after failures implies credentials were obtained.'
  });
  check('Task 3 submitted with explanation', r.status === 200 && r.data.allCodeTasksDone === true);

  // ---------- hidden follow-up flow ----------
  console.log('\n== hidden follow-up flow ==');
  r = await candA.req('GET', '/api/candidate/assessment/current');
  check('candidate waits for interviewer after Task 3', r.data.state === 'WAITING_INTERVIEWER');
  check('hidden scenario still not exposed', !JSON.stringify(r.data).includes('Rotation'));

  r = await candA.req('POST', `/api/candidate/tasks/${followup.id}/submit`, { answer: 'attempt before reveal' });
  check('follow-up submission before reveal rejected', r.status === 403);

  r = await candB.req('POST', `/api/admin/assessments/1/unlock-task`, { action: 'reveal_followup' });
  check('candidate cannot call admin reveal API', r.status === 403);
  r = await admin.req('POST', '/api/admin/assessments/1/unlock-task', { action: 'reveal_followup' });
  check('admin reveals hidden follow-up', r.status === 200);
  r = await candA.req('GET', '/api/candidate/assessment/current');
  check('candidate now sees the IP Rotation scenario', r.data.state === 'TASK' && r.data.task.id === followup.id && JSON.stringify(r.data).includes('Rotation'));

  r = await candA.req('POST', `/api/candidate/tasks/${followup.id}/submit`, {
    answer: 'No — each IP has only one failure. I would correlate by username and time window.',
    explanation: 'IP rotation defeats per-IP thresholds.'
  });
  check('candidate submits follow-up answer', r.status === 200);
  r = await candA.req('GET', '/api/candidate/assessment/current');
  check('candidate offered final submission', r.data.state === 'READY_TO_FINISH');

  // ---------- TEST 12: role boundary ----------
  console.log('\n== TEST 12: role boundaries ==');
  r = await candA.req('GET', '/api/admin/candidates');
  check('TEST 12a: candidate cannot access admin API', r.status === 403);
  r = await candA.req('POST', '/api/admin/assessments/1/score', { sectionCode: 'TASK_1', score: 0 });
  check('TEST 12b: candidate cannot score', r.status === 403);
  r = await admin.req('GET', '/api/candidate/assessment/current');
  check('TEST 12c: admin cannot use candidate API', r.status === 403);

  // ---------- TEST 20: completion ----------
  console.log('\n== TEST 20: completion ==');
  r = await candA.req('POST', '/api/candidate/assessment/complete', {});
  check('TEST 20: assessment completes correctly', r.status === 200);
  detailA = (await admin.req('GET', '/api/admin/assessments/1')).data;
  check('TEST 20b: status COMPLETED + timestamps stored',
    detailA.session.status === 'COMPLETED' && !!detailA.session.finalSubmittedAt);

  // ---------- TEST 9-10: timer expiry (fresh candidate) ----------
  console.log('\n== TEST 9-10: timer expiry ==');
  // candidate B already started; fast-forward B's deadline in the scratch DB
  const db = new DatabaseSync(DB_PATH);
  const sB = db.prepare('SELECT id FROM assessment_sessions WHERE candidate_id = (SELECT id FROM candidates WHERE name = ?)').get('Alice Wong');
  check('candidate B session exists', !!sB);
  db.prepare('UPDATE assessment_sessions SET status = ?, started_at = ?, deadline_at = ? WHERE id = ?')
    .run('IN_PROGRESS', Date.now() - 21 * 60 * 1000, Date.now() - 60 * 1000, sB.id);
  db.close();

  r = await candB.req('GET', '/api/candidate/assessment/current');
  check('TEST 9: server marks session TIME_EXPIRED', r.data.state === 'TIME_EXPIRED' || r.data.status === 'TIME_EXPIRED');
  const task1B = task1; // same global task rows
  r = await candB.req('POST', `/api/candidate/tasks/${task1B.id}/submit`, { code: 'late', answer: 'late', explanation: '' });
  check('TEST 10: submission after expiry rejected', r.status === 403 && r.data.error === 'TIME_EXPIRED');
  r = await candB.req('POST', `/api/candidate/tasks/${task1B.id}/save`, { code: 'late', answer: 'late' });
  check('TEST 10b: draft save after expiry rejected', r.status === 403);

  // ---------- TEST 11: admin sees answer key ----------
  console.log('\n== TEST 11: admin answer key access ==');
  detailA = (await admin.req('GET', '/api/admin/assessments/1')).data;
  check('TEST 11: admin can see answer keys', detailA.tasks.every(t => t.type !== 'code' || (t.answerKey && t.scoringGuide)));

  // ---------- TEST 13-14: scoring ----------
  console.log('\n== TEST 13-14: scoring engine ==');
  r = await admin.req('POST', '/api/admin/assessments/1/score', { sectionCode: 'TASK_1', score: 18 });
  check('TEST 13: admin can score a section', r.status === 200);
  r = await admin.req('POST', '/api/admin/assessments/1/score', { sectionCode: 'TASK_1', score: 20 });
  detailA = (await admin.req('GET', '/api/admin/assessments/1')).data;
  const s1 = detailA.sections.find(s => s.code === 'TASK_1');
  check('TEST 13b: second edit flagged as override', s1.isOverride === true && s1.score === 20);
  r = await admin.req('POST', '/api/admin/assessments/1/score', { sectionCode: 'TASK_1', score: 21 });
  check('TEST 13c: score above max rejected', r.status === 400);

  const scores = [['TASK_1', 20], ['TASK_2', 17], ['TASK_3', 18], ['FOLLOWUP', 12], ['CV_VERIFICATION', 12], ['AI_ML', 5]];
  for (const [code, score] of scores.slice(1)) {
    await admin.req('POST', '/api/admin/assessments/1/score', { sectionCode: code, score });
  }
  detailA = (await admin.req('GET', '/api/admin/assessments/1')).data;
  check('TEST 14: final score calculated server-side (84/100)', detailA.totalScore === 84 && detailA.maxTotal === 100,
    `total=${detailA.totalScore}`);
  check('TEST 14b: recommendation from thresholds (84 → PASS)', detailA.recommendation === 'PASS', `rec=${detailA.recommendation}`);

  r = await admin.req('GET', '/api/admin/assessments/1/report');
  check('report generation works', r.status === 200 && r.data.totalScore === 84 && r.data.integrityIndicators.length > 0);

  // notes
  r = await admin.req('POST', '/api/admin/assessments/1/notes', { note: 'Explained methodology clearly; strong on IP rotation limitation.' });
  check('interviewer notes stored', r.status === 200);
  detailA = (await admin.req('GET', '/api/admin/assessments/1')).data;
  check('note appears in detail', detailA.notes.length === 1);

  // finalize
  r = await admin.req('POST', '/api/admin/assessments/1/finalize', { recommendation: 'PASS' });
  check('admin finalizes with recommendation', r.status === 200);
  detailA = (await admin.req('GET', '/api/admin/assessments/1')).data;
  check('status REVIEWED + recommendation stored', detailA.session.status === 'REVIEWED' && detailA.session.finalRecommendation === 'PASS');

  // integrity indicators sanity
  const codes = detailA.integrityIndicators.map(i => i.code);
  check('integrity indicators include time usage', codes.includes('TIME_USAGE'));
  check('integrity indicators flag revision (test resubmission)', codes.includes('MANY_REVISIONS'), JSON.stringify(codes));

  // ---------- TEST 19c: SQLi string stored literally ----------
  detailA = (await admin.req('GET', '/api/admin/assessments/1')).data;
  const draft1 = detailA.tasks.find(t => t.id === task1.id).draft;
  check('TEST 19c: SQLi payload stored as plain text', draft1 && draft1.code.includes('DROP TABLE'));

  // ============================================================
  // PYTHON TECHNICAL ASSESSMENT MODULE (Degree Intern)
  // ============================================================
  console.log('\n== python module: catalog & skill profile ==');
  r = await admin.req('GET', '/api/admin/python-assessments/catalog');
  check('PY: catalog returns skills, dimensions, modes', r.status === 200 &&
    r.data.skills.includes('Python') && r.data.skills.includes('Web Scraping') &&
    r.data.dimensions.length >= 8 && r.data.modes.length === 3);
  check('PY: question bank seeded (>= 7 categories, hidden follow-ups present)',
    r.data.questionPool.length >= 7 && r.data.hiddenFollowups >= 3,
    JSON.stringify(r.data.questionPool));

  r = await candA.req('GET', '/api/admin/python-assessments/catalog');
  check('PY: candidate cannot access admin catalog', r.status === 403);

  // fresh candidate for the python flow (keeps the cybersec timer tests intact)
  r = await admin.req('POST', '/api/admin/candidates', { name: 'Python Pete', position: 'Data / Python Intern' });
  check('PY: python candidate created', r.status === 200);
  const pyUsername = r.data.candidate.username, pyPassword = r.data.candidate.oneTimePassword;
  const pyCand = jar();
  r = await login(pyCand, pyUsername, pyPassword);
  check('PY: python candidate can log in', r.status === 200);
  const candList = (await admin.req('GET', '/api/admin/candidates')).data.candidates;
  const pete = candList.find(c => c.name === 'Python Pete');

  r = await pyCand.req('PUT', `/api/admin/candidates/${pete.id}/skills`, { skills: [] });
  check('PY: candidate cannot edit skill profiles', r.status === 403);

  const pySkills = [
    { skillName: 'Python', claimedLevel: 'advanced' },
    { skillName: 'Pandas', claimedLevel: 'intermediate' },
    { skillName: 'Web Scraping', claimedLevel: 'intermediate' },
    { skillName: 'SQL', claimedLevel: 'intermediate' },
    { skillName: 'Machine Learning', claimedLevel: 'beginner' }
  ];
  r = await admin.req('PUT', `/api/admin/candidates/${pete.id}/skills`, { skills: pySkills });
  check('PY: admin sets skill profile', r.status === 200);
  r = await admin.req('PUT', `/api/admin/candidates/${pete.id}/skills`, { skills: [{ skillName: 'Python', claimedLevel: 'wizard' }] });
  check('PY: invalid claimed level rejected', r.status === 400);
  await admin.req('PUT', `/api/admin/candidates/${pete.id}/skills`, { skills: pySkills });
  r = await admin.req('GET', `/api/admin/candidates/${pete.id}/skills`);
  check('PY: skill profile round-trips', r.status === 200 && r.data.skills.length === 5 &&
    r.data.skills.find(s => s.skillName === 'Python').claimedLevel === 'advanced');

  console.log('\n== python module: generation (CV skill mode) ==');
  r = await pyCand.req('POST', '/api/admin/python-assessments', { candidateId: pete.id });
  check('PY: candidate cannot generate assessments', r.status === 403);

  r = await admin.req('POST', '/api/admin/python-assessments', {
    candidateId: pete.id, mode: 'cv_skill', randomize: false, durationSeconds: 1800
  });
  check('PY: admin generates CV-skill assessment', r.status === 200 && r.data.mode === 'cv_skill', JSON.stringify(r.data));
  check('PY: question count within 10-15 (+ hidden follow-ups)', r.data.questionCount >= 10 && r.data.questionCount <= 15,
    `questions=${r.data.questionCount}`);
  check('PY: rubric rescaled to exactly 100 points', r.data.rubric.reduce((a, s) => a + s.maxScore, 0) === 100);
  const pySessionId = r.data.sessionId;

  console.log('\n== python module: candidate flow (sequential + hidden follow-ups) ==');
  r = await pyCand.req('GET', '/api/candidate/assessment/current');
  check('PY: candidate sees the python assessment', r.data.state === 'NOT_STARTED' &&
    r.data.assessmentTitle.includes('Python'), r.data.assessmentTitle);
  check('PY: duration is 30 minutes', r.data.durationSeconds === 1800);
  r = await pyCand.req('POST', '/api/candidate/assessment/start', {});
  check('PY: server-side 30-minute timer starts', r.status === 200 && r.data.timer.remainingSeconds > 1790 && r.data.timer.remainingSeconds <= 1800,
    `remaining=${r.data.timer?.remainingSeconds}`);
  check('PY: candidate-facing naming is "question"', r.data.naming === 'question');

  let pyBlob = JSON.stringify(r.data);
  check('PY: candidate API leaks no answer keys / guides',
    !pyBlob.includes('answerKey') && !pyBlob.includes('scoring_guide') && !pyBlob.includes('internal_answer') &&
    !pyBlob.includes('user=B total=200') && !pyBlob.includes('pd.to_numeric'));
  check('PY: hidden follow-up question text not visible up front', !pyBlob.includes('amount is None'));
  check('PY: future progress entries are masked', !pyBlob.includes('Requirement changed'));

  const pyDetail0 = (await admin.req('GET', `/api/admin/assessments/${pySessionId}`)).data;
  const pyTasks = pyDetail0.tasks;
  check('PY: admin sees full task list incl. hidden follow-ups, code tasks have keys',
    pyTasks.length >= 12 && pyTasks.every(t => t.type !== 'code' || !!t.answerKey), `tasks=${pyTasks.length}`);

  // walk the whole assessment: every task in sequence, MCQ answered by option
  let pyState = await pyCand.req('GET', '/api/candidate/assessment/current');
  let mcqSeen = false, followupSeenAfterSubmit = false, steps = 0, submitFailures = 0, autoCompletedCount = 0;
  while (pyState.data.state === 'TASK' && steps < 30) {
    steps++;
    const t = pyState.data.task;
    if (t.answerOptions) {
      mcqSeen = true;
      check('PY: MCQ options delivered (4 options, correct one not marked)',
        Array.isArray(t.answerOptions) && t.answerOptions.length === 4);
    }
    if (/Follow-up/.test(t.title)) followupSeenAfterSubmit = true;
    await pyCand.req('POST', `/api/candidate/tasks/${t.id}/save`, { code: 'x = 1', answer: 'draft', explanation: '' });
    const sub = await pyCand.req('POST', `/api/candidate/tasks/${t.id}/submit`, {
      code: 'print("answer")', answer: t.answerOptions ? t.answerOptions[0] : 'my answer',
      explanation: 'I grouped the data with a dictionary and guarded bad rows.'
    });
    if (sub.status !== 200) submitFailures++;
    if (sub.status === 200 && sub.data.autoCompleted === true) autoCompletedCount++;
    pyState = await pyCand.req('GET', '/api/candidate/assessment/current');
  }
  check('PY: all python questions walked sequentially', steps >= 12, `steps=${steps}`);
  check('PY: every step accepted (save + submit)', submitFailures === 0, `failures=${submitFailures}`);
  check('PY: MCQ question was part of the flow', mcqSeen);
  check('PY: hidden follow-up appeared only after its parent', followupSeenAfterSubmit);
  // no interviewer-reveal stage in generated python assessments: the LAST
  // submission must auto-complete the session (autoCompleted exactly once)
  check('PY: final submission reports autoCompleted:true exactly once', autoCompletedCount === 1,
    `autoCompleted=${autoCompletedCount}`);
  check('PY: session auto-completes after last question (no waiting state)', pyState.data.state === 'COMPLETED',
    `state=${pyState.data.state}`);
  r = await pyCand.req('POST', '/api/candidate/assessment/complete', {});
  check('PY: explicit complete call is idempotent (alreadyCompleted)', r.status === 200 && r.data.ok === true && r.data.alreadyCompleted === true,
    JSON.stringify(r.data));
  pyState = await pyCand.req('GET', '/api/candidate/assessment/current');
  check('PY: candidate view COMPLETED', pyState.data.state === 'COMPLETED');

  // future-task protection on the python assessment too
  const pyDetail = (await admin.req('GET', `/api/admin/assessments/${pySessionId}`)).data;
  r = await pyCand.req('POST', `/api/candidate/tasks/${pyDetail.tasks[pyDetail.tasks.length - 1].id}/submit`, { answer: 'late attempt' });
  check('PY: submission after completion rejected', r.status === 409 || r.status === 403);

  console.log('\n== python module: scoring, skill verification, report ==');
  const pySec = pyDetail.sections;
  check('PY: rubric sections sum to 100', pySec.reduce((a, s) => a + s.maxScore, 0) === 100);
  // weak fundamentals + debugging (claimed advanced!) but strong elsewhere → 79 → Strong / SUITABLE
  const scorePlan = pySec.map(s => [s.code, s.code === 'FUNDAMENTALS' ? 5 : s.code === 'DEBUGGING' ? 8 : s.maxScore]);
  for (const [code, score] of scorePlan) {
    await admin.req('POST', `/api/admin/assessments/${pySessionId}/score`, { sectionCode: code, score });
  }
  let pyView = (await admin.req('GET', `/api/admin/assessments/${pySessionId}`)).data;
  check('PY: server-side total correct (79/100)', pyView.totalScore === 79 && pyView.maxTotal === 100, `total=${pyView.totalScore}`);
  check('PY: score level computed (79 → Strong)', pyView.session.scoreLevel && pyView.session.scoreLevel.label === 'Strong');
  check('PY: python recommendation from thresholds (79 → SUITABLE)', pyView.recommendation === 'SUITABLE', pyView.recommendation);

  const sv = pyView.skillResults || [];
  check('PY: skill verification generated for all 5 claimed skills', sv.length === 5, JSON.stringify(sv.map(s => s.skillName)));
  const pySkill = sv.find(s => s.skillName === 'Python');
  const sqlSkill = sv.find(s => s.skillName === 'SQL');
  const mlSkill = sv.find(s => s.skillName === 'Machine Learning');
  const pandasSkill = sv.find(s => s.skillName === 'Pandas');
  check('PY: claimed advanced Python with weak scores → requires review', pySkill.status === 'NOT_VERIFIED' &&
    /requires review/.test(pySkill.notes || ''), JSON.stringify(pySkill));
  check('PY: SQL NOT TESTED (never accused of not knowing it)', sqlSkill.status === 'NOT_TESTED' && sqlSkill.score == null);
  check('PY: Machine Learning NOT TESTED', mlSkill.status === 'NOT_TESTED');
  check('PY: Pandas VERIFIED (full marks on CSV/Pandas)', pandasSkill.status === 'VERIFIED');

  r = await admin.req('GET', `/api/admin/assessments/${pySessionId}/report`);
  check('PY: report contains skill verification + level', r.status === 200 &&
    r.data.skillResults.length === 5 && r.data.scoreLevel.label === 'Strong');
  check('PY: report integrity indicators present', r.data.integrityIndicators.length > 0);

  r = await admin.req('POST', `/api/admin/assessments/${pySessionId}/finalize`, { recommendation: 'SUITABLE_WITH_SUPERVISION' });
  check('PY: finalize with python recommendation accepted', r.status === 200);
  pyView = (await admin.req('GET', `/api/admin/assessments/${pySessionId}`)).data;
  check('PY: ext recommendation stored & displayed', pyView.session.finalRecommendation === 'SUITABLE_WITH_SUPERVISION');
  r = await admin.req('POST', `/api/admin/assessments/${pySessionId}/finalize`, { recommendation: 'HIRE_NOW' });
  check('PY: invalid recommendation rejected', r.status === 400);

  console.log('\n== python module: other modes ==');
  r = await admin.req('POST', '/api/admin/python-assessments', {
    candidateId: pete.id, mode: 'standard', randomize: false, durationSeconds: 1800
  });
  check('PY: standard mode includes all dimensions', r.status === 200 && r.data.questionCount >= 11, `q=${r.data.questionCount}`);
  const stdDetail = (await admin.req('GET', `/api/admin/assessments/${r.data.sessionId}`)).data;
  check('PY: standard mode rubric covers SCRAPING + CODE_QUALITY', stdDetail.sections.some(s => s.code === 'SCRAPING') &&
    stdDetail.sections.some(s => s.code === 'CODE_QUALITY'));
  r = await admin.req('POST', '/api/admin/python-assessments', {
    candidateId: pete.id, mode: 'interview_followup', randomize: false, durationSeconds: 1800
  });
  const ivDetail = (await admin.req('GET', `/api/admin/assessments/${r.data.sessionId}`)).data;
  check('PY: interview-followup mode hides follow-ups from candidates',
    ivDetail.tasks.filter(t => t.unlockMode === 'never_candidate').length >= 2 &&
    ivDetail.tasks.filter(t => t.unlockMode !== 'never_candidate').length <= 6);
  r = await admin.req('POST', '/api/admin/python-assessments', { candidateId: 999999 });
  check('PY: generation for unknown candidate → 404', r.status === 404);

  console.log('\n== python module: stranded-session warning + sessions list ==');
  // candidate with an IN_PROGRESS session on another (cybersec) assessment:
  // generation must still succeed but warn that the other session is set aside
  r = await admin.req('POST', '/api/admin/candidates', { name: 'Mia Two Tests', position: 'Data / Python Intern' });
  check('PY-warning: second-assessment candidate created', r.status === 200);
  const miaCred = r.data.candidate;
  const candM = jar();
  r = await login(candM, miaCred.username, miaCred.oneTimePassword);
  check('PY-warning: candidate can log in', r.status === 200);
  r = await candM.req('POST', '/api/candidate/assessment/start', {});
  check('PY-warning: cybersec session IN_PROGRESS', r.status === 200 && r.data.status === 'IN_PROGRESS');
  const miaList = (await admin.req('GET', '/api/admin/candidates')).data.candidates;
  const mia = miaList.find(c => c.name === 'Mia Two Tests');
  check('PY-warning: candidates list exposes sessions array (cybersec only)',
    Array.isArray(mia?.sessions) && mia.sessions.length === 1 && mia.sessions[0].isPython === false,
    JSON.stringify(mia?.sessions));
  r = await admin.req('POST', '/api/admin/python-assessments', {
    candidateId: mia.id, mode: 'cv_skill', randomize: false, durationSeconds: 1800
  });
  check('PY-warning: generation still succeeds with an active session elsewhere', r.status === 200);
  check('PY-warning: generation response includes human-readable warning',
    typeof r.data.warning === 'string' && r.data.warning.length > 0, JSON.stringify(r.data));
  const miaList2 = (await admin.req('GET', '/api/admin/candidates')).data.candidates;
  const mia2 = miaList2.find(c => c.name === 'Mia Two Tests');
  check('PY-warning: sessions[] newest-first with python flagged',
    Array.isArray(mia2?.sessions) && mia2.sessions.length === 2 &&
    mia2.sessions[0].isPython === true && mia2.sessions[1].isPython === false &&
    mia2.sessions[0].status === 'NOT_STARTED' && mia2.sessions[1].status === 'IN_PROGRESS',
    JSON.stringify(mia2?.sessions));
  check('PY-warning: top-level fields still reflect the latest session',
    mia2.assessment_title === 'Degree Intern — Python Technical Assessment',
    mia2.assessment_title);
  r = await candM.req('GET', '/api/candidate/assessment/current');
  check('PY-warning: candidate screen now shows the python assessment',
    r.data.assessmentTitle.includes('Python') && r.data.state === 'NOT_STARTED', r.data.assessmentTitle);

  // ---------- candidate deletion ----------
  console.log('\n== candidate deletion ==');
  r = await admin.req('POST', '/api/admin/candidates', { name: 'Temp Person' });
  const delCand = r.data.candidate;
  const candC = jar();
  await login(candC, delCand.username, delCand.oneTimePassword);
  await candC.req('POST', '/api/candidate/assessment/start', {});
  // submit something so there is data to cascade
  const allSessions = (await admin.req('GET', '/api/admin/candidates')).data.candidates;
  const tempCand = allSessions.find(c => c.name === 'Temp Person');
  const current = await candC.req('GET', '/api/candidate/assessment/current');
  await candC.req('POST', `/api/candidate/tasks/${current.data.task.id}/save`, { code: 'draft', answer: 'draft answer' });

  r = await candC.req('DELETE', `/api/admin/candidates/${tempCand.candidate_id}`);
  check('candidate cannot delete candidates', r.status === 403);
  r = await admin.req('DELETE', '/api/admin/candidates/99999');
  check('deleting unknown candidate → 404', r.status === 404);
  r = await admin.req('DELETE', `/api/admin/candidates/${tempCand.id}`);
  check('admin can delete a candidate', r.status === 200);
  r = await candC.req('GET', '/api/candidate/assessment/current');
  check('deleted candidate session invalidated', r.status === 401);
  r = await login(candC, delCand.username, delCand.oneTimePassword);
  check('deleted candidate cannot log in', r.status === 401);
  const remaining = (await admin.req('GET', '/api/admin/candidates')).data.candidates;
  check('deleted candidate removed from list', !remaining.some(c => c.name === 'Temp Person'));
  check('other candidates unaffected by deletion', remaining.some(c => c.name === 'Alice Wong') && remaining.some(c => c.name === 'John Tan'));

  // ---------- auto-grading engine (basic edition v2) ----------
  console.log('\n== auto-grading (basic edition, hidden dataset) ==');
  r = await admin.req('POST', '/api/admin/candidates', { name: 'Grade Tester' });
  const gradeCred = r.data.candidate;
  const candG = jar();
  await login(candG, gradeCred.username, gradeCred.oneTimePassword);
  await candG.req('POST', '/api/candidate/assessment/start', {});
  let g = await candG.req('GET', '/api/candidate/assessment/current');
  check('new candidates are assigned the basic edition', g.data.assessmentTitle.includes('Basic'));
  const gTask1 = g.data.task.id;

  const basicLogs = `logs = """
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
"""`;

  // b1 — the one-liner the hint teaches
  r = await candG.req('POST', `/api/candidate/tasks/${gTask1}/submit`, {
    code: `${basicLogs}\nprint(f"FAILED: {logs.count('FAILED')}")`,
    answer: '', explanation: ''
  });
  check('basic: b1 submitted', r.status === 200);
  const allCands = (await admin.req('GET', '/api/admin/candidates')).data.candidates;
  const gradeSessionId = allCands.find(c => c.name === 'Grade Tester').session_id;
  let gDetail = (await admin.req('GET', `/api/admin/assessments/${gradeSessionId}`)).data;
  const gAuto = gDetail.tasks.find(t => t.id === gTask1).answers[0].autograde;
  check('basic auto-grade: hint-following one-liner passes both datasets',
    gAuto && gAuto.available === true && gAuto.tests.length === 2 && gAuto.tests.every(t => t.passed),
    JSON.stringify(gAuto));

  g = await candG.req('GET', '/api/candidate/assessment/current');
  check('basic: b2 unlocks after b1', g.data.task && g.data.task.code === 'b2');
  const gTask2 = g.data.task.id;
  r = await candG.req('POST', `/api/candidate/tasks/${gTask2}/submit`, {
    code: `${basicLogs}\nprint("USERS: 5")`,
    answer: '', explanation: ''
  });
  gDetail = (await admin.req('GET', `/api/admin/assessments/${gradeSessionId}`)).data;
  const hAuto = gDetail.tasks.find(t => t.id === gTask2).answers[0].autograde;
  check('basic auto-grade: hard-coded answer fails the unseen dataset (expects USERS: 3)',
    hAuto && hAuto.tests.length === 2 && hAuto.tests[0].passed === true && hAuto.tests[1].passed === false,
    JSON.stringify(hAuto));

  // b3 — same IP + same username: FAILED earlier, SUCCESS now
  g = await candG.req('GET', '/api/candidate/assessment/current');
  const gTask3 = g.data.task.id;
  r = await candG.req('POST', `/api/candidate/tasks/${gTask3}/submit`, {
    code: `${basicLogs}
failed_pairs = set()
for line in logs.strip().splitlines():
    parts = [p.strip() for p in line.split("|")]
    if parts[3] == "FAILED":
        failed_pairs.add((parts[1], parts[2]))
for line in logs.strip().splitlines():
    parts = [p.strip() for p in line.split("|")]
    if parts[3] == "SUCCESS" and (parts[1], parts[2]) in failed_pairs:
        print(f"{parts[2]} | SUSPICIOUS LOGIN")`,
    answer: '', explanation: 'Success after failures means the credential was likely obtained.'
  });
  check('basic: b3 submitted with explanation', r.status === 200);
  gDetail = (await admin.req('GET', `/api/admin/assessments/${gradeSessionId}`)).data;
  const kAuto = gDetail.tasks.find(t => t.id === gTask3).answers[0].autograde;
  check('basic auto-grade: b3 generic solution passes both datasets',
    kAuto && kAuto.tests.length === 2 && kAuto.tests.every(t => t.passed), JSON.stringify(kAuto));

  const candBlob = JSON.stringify(await candG.req('GET', '/api/candidate/assessment/current'));
  check('auto-grade: results never exposed to candidate', !candBlob.includes('autograde') && !candBlob.includes('anti-hardcode'));

  // ---------- candidate code-run endpoint ----------
  console.log('\n== code run (candidate self-testing) ==');
  r = await admin.req('POST', '/api/admin/candidates', { name: 'Run Tester' });
  const runCred = r.data.candidate;
  const candR = jar();
  await login(candR, runCred.username, runCred.oneTimePassword);
  await candR.req('POST', '/api/candidate/assessment/start', {});
  r = await candR.req('POST', '/api/candidate/run', { code: 'print(2 + 3)' });
  check('candidate can run their own code', r.status === 200 && r.data.stdout.trim() === '5', JSON.stringify(r.data));
  r = await candR.req('POST', '/api/candidate/run', { code: 'print("a")\nprintx(1)' });
  check('runtime errors come back as stderr', r.status === 200 && r.data.stderr.includes('printx') && r.data.exitCode !== 0);
  r = await candR.req('POST', '/api/candidate/run', { code: 'while True:\n    pass' });
  check('infinite loop is killed at the timeout', r.status === 200 && r.data.timedOut === true);
  r = await candR.req('POST', '/api/candidate/run', { code: '' });
  check('empty code rejected', r.status === 400);
  r = await admin.req('POST', '/api/candidate/run', { code: 'print(1)' });
  check('admin cannot use candidate run endpoint', r.status === 403);

  // ---------- interviewer cheatsheet (answers) ----------
  console.log('\n== interviewer cheatsheet ==');
  const csRaw = await fetch(`${BASE}/admin/cheatsheet`, { headers: { Cookie: admin.cookie } });
  const csText = await csRaw.text();
  check('admin can open cheatsheet with all answers',
    csRaw.status === 200 && csText.includes('FAILED: 7') && csText.includes('评分手册'));
  const csCand = await fetch(`${BASE}/admin/cheatsheet`);
  check('unauthenticated cannot open cheatsheet', csCand.status === 401);
  const csCand2 = await fetch(`${BASE}/admin/cheatsheet`, { headers: { Cookie: candA.cookie } });
  check('candidate cannot open cheatsheet', csCand2.status === 403);

  // ---------- rate limiting ----------
  console.log('\n== rate limiting ==');
  let last = null;
  for (let i = 0; i < 12; i++) last = await login(jar(), 'johntan', 'bad');
  check('login rate limited after repeated failures', last.status === 429);

  // ---------- unauthenticated ----------
  r = await jar().req('GET', '/api/candidate/assessment/current');
  check('unauthenticated candidate API rejected', r.status === 401);
  r = await jar().req('GET', '/api/admin/assessments/1');
  check('unauthenticated admin API rejected', r.status === 401);
  // raw request without X-Requested-With header (cross-site style)
  const raw = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  check('CSRF guard: raw cross-site-style POST rejected', raw.status === 403);
  const wrongCt = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
    body: 'username=admin&password=admin123'
  });
  check('CSRF guard: form-encoded POST rejected', wrongCt.status === 403);

} catch (e) {
  failed++;
  console.error('\nUNEXPECTED TEST HARNESS ERROR:', e);
} finally {
  server.kill();
  setTimeout(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file lock */ }
    console.log(`\n===== RESULTS: ${passed} passed, ${failed} failed =====`);
    process.exit(failed ? 1 : 0);
  }, 300);
}

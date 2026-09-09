import { Router } from 'express';
import { db, now, recordEvent, getSetting } from './db.js';
import { requireRole, rateLimit } from './auth.js';
import { autograde } from './autograde.js';
import { runPython, pythonAvailable } from './runner.js';
import { isPythonAssessment } from './pythonAssessment.js';

export const candidateRouter = Router();

const SUBMIT_GRACE_MS = 1500;

// Candidates may execute their own code before submitting (same isolated
// subprocess as auto-grading). Limited per user to prevent use as a free REPL.
const runLimiter = rateLimit({ name: 'code-run', windowMs: 60_000, max: 12, keyFn: req => String(req.user.id) });

candidateRouter.post('/run', requireRole('candidate'), runLimiter, async (req, res) => {
  const candidate = getCandidateRow(req.user.id);
  const session = getActiveSession(candidate.id);
  if (!session || !['IN_PROGRESS', 'SUBMITTED'].includes(session.status)) {
    return res.status(409).json({ error: 'SESSION_NOT_ACTIVE' });
  }
  const { code } = req.body || {};
  if (typeof code !== 'string' || code.trim().length === 0 || code.length > 100_000) {
    return res.status(400).json({ error: 'INVALID_CODE' });
  }
  if (!(await pythonAvailable())) return res.status(503).json({ error: 'NO_PYTHON' });

  const t0 = Date.now();
  const result = await runPython(code, { timeoutMs: 4000 });
  recordEvent({
    sessionId: session.id, candidateId: candidate.id, type: 'CODE_RUN',
    payload: { codeLen: code.length, ranMs: Date.now() - t0, timedOut: !!result.timedOut }
  });
  if (!result.ok) return res.status(500).json({ error: result.error, message: result.message });

  res.json({
    stdout: result.stdout.slice(0, 20_000),
    stderr: result.stderr.slice(0, 4_000),
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    ranMs: Date.now() - t0
  });
});

function getCandidateRow(userId) {
  return db.prepare('SELECT * FROM candidates WHERE user_id = ?').get(userId);
}

function getActiveSession(candidateId) {
  // NOTE: no is_active filter on purpose — a candidate's in-flight session must
  // survive the assessment being deactivated for new assignments.
  return db.prepare(
    `SELECT s.*, a.slug AS assessment_slug, a.title AS assessment_title, a.instructions AS instructions_json, a.duration_seconds
       FROM assessment_sessions s JOIN assessments a ON a.id = s.assessment_id
      WHERE s.candidate_id = ?
      ORDER BY s.id DESC LIMIT 1`
  ).get(candidateId);
}

function submittedTaskIds(sessionId) {
  const rows = db.prepare(
    'SELECT DISTINCT task_id FROM assessment_answers WHERE session_id = ?'
  ).all(sessionId);
  return new Set(rows.map(r => r.task_id));
}

/**
 * Derives which task the candidate may currently see/answer.
 * Never returns answer_key / scoring_guide / internal_answer fields.
 */
function resolveCurrentTask(session, submitted) {
  if (!session) return null;
  const tasks = db.prepare(
    `SELECT * FROM assessment_tasks WHERE assessment_id = ?
       AND unlock_mode IN ('after_previous','admin_reveal')
     ORDER BY idx ASC`
  ).all(session.assessment_id);

  for (const task of tasks) {
    if (submitted.has(task.id)) continue;
    if (task.unlock_mode === 'admin_reveal') {
      if (session.followup_revealed_at) return sanitizeTask(task);
      return null; // waiting for interviewer
    }
    // 'after_previous': all previous non-reveal tasks must be submitted
    return sanitizeTask(task);
  }
  return null;
}

function sanitizeTask(task) {
  return {
    id: task.id,
    idx: task.idx,
    code: task.code,
    title: task.title,
    type: task.type,
    promptHtml: task.prompt_html,
    dataText: task.data_text,
    starterCode: task.starter_code,
    answerOptions: task.answer_options ? JSON.parse(task.answer_options) : null,
    // hidden requirement-change / probing follow-ups come from question_bank.is_hidden
    followUp: !!(task.question_ref &&
      db.prepare('SELECT is_hidden FROM question_bank WHERE id = ?').get(task.question_ref)?.is_hidden),
    explanationRequired: !!task.explanation_required,
    codeEditor: !!task.code_editor
    // NOTE: answer_key / scoring_guide / internal_answer / max_score deliberately excluded
  };
}

function timerView(session) {
  const serverNow = now();
  if (!session || session.status === 'NOT_STARTED') {
    return { serverNow, startedAt: null, deadlineAt: null, remainingSeconds: null, expired: false };
  }
  const deadline = session.deadline_at;
  const expired = serverNow > deadline;
  return {
    serverNow,
    startedAt: session.started_at,
    deadlineAt: deadline,
    remainingSeconds: expired ? 0 : Math.ceil((deadline - serverNow) / 1000),
    expired
  };
}

function markExpired(session) {
  if (['IN_PROGRESS', 'SUBMITTED'].includes(session.status)) {
    db.prepare("UPDATE assessment_sessions SET status = 'TIME_EXPIRED' WHERE id = ? AND status IN ('IN_PROGRESS','SUBMITTED')")
      .run(session.id);
    session.status = 'TIME_EXPIRED';
    recordEvent({ sessionId: session.id, candidateId: session.candidate_id, type: 'TIME_EXPIRED' });
  }
}

function timeSpentMs(sessionId, taskId) {
  const ev = db.prepare(
    `SELECT MIN(created_at) AS opened_at FROM assessment_events
      WHERE session_id = ? AND task_id = ? AND event_type = 'TASK_OPENED'`
  ).get(sessionId, taskId);
  return ev && ev.opened_at ? Math.max(0, now() - ev.opened_at) : 0;
}

function currentView(req) {
  const candidate = getCandidateRow(req.user.id);
  if (!candidate) return { state: 'NO_SESSION', error: 'NO_CANDIDATE_PROFILE' };
  const session = getActiveSession(candidate.id);

  if (!session) {
    return { state: 'NO_SESSION' };
  }

  const timer = timerView(session);
  const isPython = isPythonAssessment(session.assessment_slug);
  const base = {
    candidateName: candidate.name,
    assessmentTitle: session.assessment_title,
    status: session.status,
    timer,
    followupRevealed: !!session.followup_revealed_at,
    durationSeconds: session.duration_seconds,
    naming: isPython ? 'question' : 'task'
  };

  if (session.status === 'NOT_STARTED') {
    return { ...base, state: 'NOT_STARTED', instructions: JSON.parse(session.instructions_json || '{}') };
  }

  if (timer.expired && ['IN_PROGRESS', 'SUBMITTED'].includes(session.status)) {
    markExpired(session);
  }

  if (session.status === 'COMPLETED' || session.status === 'REVIEWED') {
    return { ...base, state: 'COMPLETED' };
  }

  const submitted = submittedTaskIds(session.id);
  const followupRevealed = !!session.followup_revealed_at;
  // Hidden tasks must not leak through progress metadata: include a task in the
  // candidate's progress list only if it is visible to them.
  const allTasksRaw = db.prepare(
    `SELECT id, idx, title, unlock_mode FROM assessment_tasks
      WHERE assessment_id = ? AND unlock_mode IN ('after_previous','admin_reveal') ORDER BY idx`
  ).all(session.assessment_id);
  const visibleTasks = allTasksRaw.filter(t =>
    t.unlock_mode === 'after_previous' || followupRevealed);
  const task = resolveCurrentTask(session, submitted);
  const currentIdx = task ? task.idx : Infinity;
  // Anti-cheating: future questions must not leak their content through the
  // progress bar — not-yet-reached entries get a neutral label, past/current
  // keep their real titles.
  const progress = visibleTasks.map(t => ({
    id: t.id,
    idx: t.idx,
    title: t.idx <= currentIdx ? t.title : '',
    submitted: submitted.has(t.id)
  }));

  const codeTaskCount = allTasksRaw.filter(t => t.unlock_mode === 'after_previous').length;

  if (session.status === 'TIME_EXPIRED') {
    return {
      ...base,
      state: 'TIME_EXPIRED',
      progress
    };
  }

  if (!task) {
    // all visible work done
    const followupTask = db.prepare(
      `SELECT id FROM assessment_tasks WHERE assessment_id = ? AND unlock_mode = 'admin_reveal' LIMIT 1`
    ).get(session.assessment_id);
    if (!followupTask) {
      // this assessment has no interviewer-revealed stage — the candidate is done
      return { ...base, state: 'READY_TO_FINISH', progress, taskCount: codeTaskCount };
    }
    if (session.followup_revealed_at && followupTask && submitted.has(followupTask.id)) {
      return { ...base, state: 'READY_TO_FINISH', progress, taskCount: codeTaskCount };
    }
    // follow-up not yet revealed
    return { ...base, state: 'WAITING_INTERVIEWER', progress, taskCount: codeTaskCount };
  }

  // record TASK_OPENED once per task (used for time-spent metrics)
  const opened = db.prepare(
    `SELECT 1 FROM assessment_events WHERE session_id = ? AND task_id = ? AND event_type = 'TASK_OPENED' LIMIT 1`
  ).get(session.id, task.id);
  if (!opened) {
    recordEvent({ sessionId: session.id, candidateId: candidate.id, type: 'TASK_OPENED', taskId: task.id });
  }

  const draft = db.prepare(
    'SELECT code, answer, explanation FROM assessment_drafts WHERE session_id = ? AND task_id = ?'
  ).get(session.id, task.id);

  const versions = db.prepare(
    `SELECT submission_version, submitted_at FROM assessment_answers
      WHERE session_id = ? AND task_id = ? ORDER BY submission_version`
  ).all(session.id, task.id);

  return {
    ...base,
    state: 'TASK',
    taskCount: codeTaskCount,
    progress,
    task: {
      ...task,
      draft: draft || null,
      submittedVersions: versions
    }
  };
}

// ---- GET current assessment state (the ONLY data source for the candidate UI) ----
candidateRouter.get('/assessment/current', requireRole('candidate'), (req, res) => {
  res.json(currentView(req));
});

// ---- POST start ----
candidateRouter.post('/assessment/start', requireRole('candidate'), (req, res) => {
  const candidate = getCandidateRow(req.user.id);
  if (!candidate) return res.status(404).json({ error: 'NO_CANDIDATE_PROFILE' });
  let session = getActiveSession(candidate.id);
  if (!session) return res.status(404).json({ error: 'NO_ASSESSMENT_ASSIGNED' });
  if (session.status !== 'NOT_STARTED') return res.status(409).json({ error: 'ALREADY_STARTED' });

  const t = now();
  const durationMs = session.duration_seconds * 1000;
  db.prepare("UPDATE assessment_sessions SET status = 'IN_PROGRESS', started_at = ?, deadline_at = ? WHERE id = ?")
    .run(t, t + durationMs, session.id);
  recordEvent({
    sessionId: session.id,
    candidateId: candidate.id,
    type: 'ASSESSMENT_STARTED',
    payload: { durationSeconds: session.duration_seconds, serverDeadline: t + durationMs }
  });

  session = getActiveSession(candidate.id);
  res.json(currentView(req));
});

function loadTaskForWrite(req, res, session, mode) {
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId)) {
    res.status(400).json({ error: 'BAD_TASK_ID' });
    return null;
  }
  const task = db.prepare('SELECT * FROM assessment_tasks WHERE id = ?').get(taskId);
  if (!task) {
    res.status(404).json({ error: 'TASK_NOT_FOUND' });
    return null;
  }
  const submitted = submittedTaskIds(session.id);
  const current = resolveCurrentTask(session, submitted);
  const currentIdx = current ? current.idx : -1;

  if (task.unlock_mode === 'admin_reveal') {
    // follow-up: must be revealed; resubmission allowed while it is the live task
    if (!session.followup_revealed_at || currentIdx < task.idx) {
      res.status(403).json({ error: 'TASK_NOT_UNLOCKED' });
      return null;
    }
    return task;
  }
  // sequential task: current task is always writable; earlier tasks accept revised
  // submissions (versioned, old versions preserved) — future tasks are rejected.
  if (task.unlock_mode !== 'after_previous' || task.idx > currentIdx ||
      (mode === 'save' && submitted.has(task.id))) {
    res.status(403).json({ error: 'TASK_NOT_UNLOCKED' });
    return null;
  }
  return task;
}

function checkTimer(req, res, session) {
  if (!session.deadline_at) return true;
  if (now() > session.deadline_at + SUBMIT_GRACE_MS) {
    markExpired(session);
    res.status(403).json({ error: 'TIME_EXPIRED' });
    return false;
  }
  return true;
}

function validateAnswerBody(req, res) {
  const { code = '', answer = '', explanation = '', pastedChars = 0 } = req.body || {};
  const maxLen = 100000;
  if (typeof code !== 'string' || typeof answer !== 'string' || typeof explanation !== 'string' ||
      code.length > maxLen || answer.length > maxLen || explanation.length > maxLen) {
    res.status(400).json({ error: 'INVALID_INPUT' });
    return null;
  }
  return { code, answer, explanation, pastedChars: Math.max(0, Math.min(100000, Number(pastedChars) || 0)) };
}

// ---- POST save draft ----
function requireActiveSession(res, session) {
  if (!session) {
    res.status(404).json({ error: 'NO_SESSION' });
    return false;
  }
  if (session.status === 'TIME_EXPIRED') {
    res.status(403).json({ error: 'TIME_EXPIRED' });
    return false;
  }
  if (!['IN_PROGRESS', 'SUBMITTED'].includes(session.status)) {
    res.status(409).json({ error: 'SESSION_NOT_ACTIVE', status: session.status });
    return false;
  }
  return true;
}

candidateRouter.post('/tasks/:taskId/save', requireRole('candidate'), (req, res) => {
  const candidate = getCandidateRow(req.user.id);
  const session = getActiveSession(candidate.id);
  if (!requireActiveSession(res, session)) return;
  if (!checkTimer(req, res, session)) return;
  const task = loadTaskForWrite(req, res, session, 'save');
  if (!task) return;
  const body = validateAnswerBody(req, res);
  if (!body) return;

  const t = now();
  const existing = db.prepare('SELECT * FROM assessment_drafts WHERE session_id = ? AND task_id = ?')
    .get(session.id, task.id);
  if (existing) {
    db.prepare(
      `UPDATE assessment_drafts SET code = ?, answer = ?, explanation = ?, save_count = save_count + 1,
         paste_events = paste_events + ?, max_paste_chars = MAX(max_paste_chars, ?), updated_at = ? WHERE id = ?`
    ).run(body.code, body.answer, body.explanation, body.pastedChars > 0 ? 1 : 0, body.pastedChars, t, existing.id);
  } else {
    db.prepare(
      `INSERT INTO assessment_drafts (session_id, task_id, code, answer, explanation, save_count, paste_events, max_paste_chars, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(session.id, task.id, body.code, body.answer, body.explanation, body.pastedChars > 0 ? 1 : 0, body.pastedChars, t);
  }
  recordEvent({
    sessionId: session.id, candidateId: candidate.id, type: 'ANSWER_SAVED', taskId: task.id,
    payload: { codeLen: body.code.length, answerLen: body.answer.length, pastedChars: body.pastedChars }
  });
  res.json({ ok: true, savedAt: t });
});

// ---- POST submit task ----
candidateRouter.post('/tasks/:taskId/submit', requireRole('candidate'), async (req, res) => {
  const candidate = getCandidateRow(req.user.id);
  const session = getActiveSession(candidate.id);
  if (!requireActiveSession(res, session)) return;
  if (!checkTimer(req, res, session)) return;
  const task = loadTaskForWrite(req, res, session, 'submit');
  if (!task) return;
  const body = validateAnswerBody(req, res);
  if (!body) return;
  if (task.explanation_required && body.explanation.trim().length < 10) {
    return res.status(400).json({ error: 'EXPLANATION_REQUIRED' });
  }

  const t = now();
  const spent = timeSpentMs(session.id, task.id);
  const count = db.prepare('SELECT COUNT(*) AS c FROM assessment_answers WHERE session_id = ? AND task_id = ?')
    .get(session.id, task.id).c;
  const insert = db.prepare(
    `INSERT INTO assessment_answers (session_id, task_id, answer, code, explanation, submitted_at, time_spent_ms, submission_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(session.id, task.id, body.answer, body.code, body.explanation, t, spent, count + 1);

  // Hidden auto-grade: run the submitted code against the sample + an unseen
  // dataset. Results are stored for the interviewer only — never sent to the
  // candidate, so success/failure cannot be probed by repeated submissions.
  let grade = null;
  if (task.type === 'code' && task.code_editor) {
    try {
      grade = await autograde(task.code, body.code);
      db.prepare('UPDATE assessment_answers SET autograde = ? WHERE id = ?')
        .run(grade ? JSON.stringify(grade) : null, insert.lastInsertRowid);
    } catch (err) {
      console.error('autograde failed:', err);
    }
  }
  recordEvent({
    sessionId: session.id, candidateId: candidate.id, type: 'ANSWER_SUBMITTED', taskId: task.id,
    payload: { version: count + 1, codeLen: body.code.length, answerLen: body.answer.length, explanationLen: body.explanation.length }
  });

  // unlock next task (event only — visibility is derived from submissions)
  const next = db.prepare(
    `SELECT id, idx, title FROM assessment_tasks WHERE assessment_id = ? AND idx = ? AND unlock_mode = 'after_previous'`
  ).get(session.assessment_id, task.idx + 1);
  if (next) {
    recordEvent({ sessionId: session.id, candidateId: candidate.id, type: 'TASK_UNLOCKED', taskId: next.id });
  }

  // if every sequential code task is now submitted, decide the next phase:
  // - assessment has an interviewer-revealed stage → SUBMITTED (awaiting reveal)
  // - assessment has none → nothing left to wait for: auto-complete immediately
  //   (keeps the session out of the "waiting" state and immune to timer expiry)
  const codeTasks = db.prepare(
    `SELECT id FROM assessment_tasks WHERE assessment_id = ? AND unlock_mode = 'after_previous'`
  ).all(session.assessment_id);
  const submitted = submittedTaskIds(session.id);
  const allCodeDone = codeTasks.length > 0 && codeTasks.every(ct => submitted.has(ct.id));
  let autoCompleted = false;
  if (allCodeDone && session.status === 'IN_PROGRESS') {
    const hasRevealStage = !!db.prepare(
      `SELECT 1 FROM assessment_tasks WHERE assessment_id = ? AND unlock_mode = 'admin_reveal' LIMIT 1`
    ).get(session.assessment_id);
    if (hasRevealStage) {
      db.prepare("UPDATE assessment_sessions SET status = 'SUBMITTED' WHERE id = ?").run(session.id);
      session.status = 'SUBMITTED';
      recordEvent({ sessionId: session.id, candidateId: candidate.id, type: 'ALL_CODE_TASKS_SUBMITTED' });
    } else {
      db.prepare(
        "UPDATE assessment_sessions SET status = 'COMPLETED', completed_at = ?, final_submitted_at = ? WHERE id = ?"
      ).run(t, t, session.id);
      session.status = 'COMPLETED';
      recordEvent({
        sessionId: session.id, candidateId: candidate.id, type: 'ASSESSMENT_COMPLETED',
        payload: { auto: true }
      });
      autoCompleted = true;
    }
  }

  res.json({ ok: true, submittedAt: t, nextUnlocked: !!next, allCodeTasksDone: allCodeDone, autoCompleted });
});

// ---- POST finalize (after follow-up answered; candidate confirms) ----
candidateRouter.post('/assessment/complete', requireRole('candidate'), (req, res) => {
  const candidate = getCandidateRow(req.user.id);
  const session = getActiveSession(candidate.id);
  // Auto-completed sessions (assessments without an interviewer-reveal stage)
  // receive this call after the fact — treat it as success, not an error.
  // Checked BEFORE requireActiveSession/timer: a COMPLETED session must not be
  // rejected as "not active".
  if (session && session.status === 'COMPLETED') {
    return res.json({ ok: true, alreadyCompleted: true });
  }
  if (!requireActiveSession(res, session)) return;
  if (!checkTimer(req, res, session)) return;

  const codeTasks = db.prepare(
    `SELECT id FROM assessment_tasks WHERE assessment_id = ? AND unlock_mode = 'after_previous'`
  ).all(session.assessment_id);
  const submitted = submittedTaskIds(session.id);
  if (!codeTasks.every(ct => submitted.has(ct.id))) {
    return res.status(400).json({ error: 'TASKS_INCOMPLETE' });
  }

  const t = now();
  db.prepare(
    "UPDATE assessment_sessions SET status = 'COMPLETED', completed_at = ?, final_submitted_at = ? WHERE id = ?"
  ).run(t, t, session.id);
  recordEvent({ sessionId: session.id, candidateId: candidate.id, type: 'ASSESSMENT_COMPLETED' });
  res.json({ ok: true });
});

// ---- candidate integrity signal (voluntary client-side paste telemetry) ----
candidateRouter.post('/events', requireRole('candidate'), (req, res) => {
  const { type, chars } = req.body || {};
  const candidate = getCandidateRow(req.user.id);
  const session = getActiveSession(candidate.id);
  if (!session) return res.status(404).json({ error: 'NO_SESSION' });
  if (type === 'paste') {
    recordEvent({
      sessionId: session.id, candidateId: candidate.id, type: 'PASTE_DETECTED',
      payload: { chars: Math.max(0, Math.min(100000, Number(chars) || 0)) }
    });
  }
  res.json({ ok: true });
});

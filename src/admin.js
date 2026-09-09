import { Router } from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, now, recordEvent, getSetting, setSetting } from './db.js';
import { requireRole } from './auth.js';
import { computeIndicators } from './indicators.js';
import {
  createPythonAssessment, buildSkillVerification, scoreLevelFor,
  pythonRecommendationFor, isPythonAssessment, PY_RECOMMENDATION_OPTIONS, ASSESSMENT_MODES
} from './pythonAssessment.js';
import { SKILL_CATALOG, DIMENSIONS, DEFAULT_SECTION_COUNTS, QUESTIONS } from './pythonQuestions.js';

export const adminRouter = Router();

function hash(password) {
  const salt = randomBytes(16).toString('hex');
  return `s1$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}
function genPassword() {
  return randomBytes(6).toString('base64url'); // one-time password shown once to the interviewer
}

function recommendationFor(totalScore) {
  if (totalScore == null) return null;
  const strong = Number(getSetting('threshold_strong_pass', '85'));
  const pass = Number(getSetting('threshold_pass', '70'));
  const review = Number(getSetting('threshold_review', '55'));
  if (totalScore >= strong) return 'STRONG_PASS';
  if (totalScore >= pass) return 'PASS';
  if (totalScore >= review) return 'REVIEW';
  return 'FAIL';
}

function getSessionOr404(req, res) {
  const id = Number(req.params.id);
  const session = db.prepare(
    `SELECT s.*, a.title AS assessment_title, a.slug AS assessment_slug, a.duration_seconds,
            c.name AS candidate_name, c.email AS candidate_email, c.position AS candidate_position
       FROM assessment_sessions s
       JOIN assessments a ON a.id = s.assessment_id
       JOIN candidates c ON c.id = s.candidate_id
      WHERE s.id = ?`
  ).get(id);
  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    return null;
  }
  return session;
}

// ---- list candidates ----
// One entry per candidate. The top-level session fields keep the LATEST session
// (backward compatible); `sessions` additionally lists ALL of the candidate's
// sessions newest-first — candidates may hold several (e.g. the cybersecurity
// test plus a generated Python assessment: after a new generation the newer
// session takes over the candidate's screen and the older one is set aside).
adminRouter.get('/candidates', requireRole('admin'), (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.name, c.email, c.position, c.created_at, u.username,
            s.id AS session_id, s.status, s.started_at, s.deadline_at, s.final_submitted_at,
            s.assessment_id, a.title AS assessment_title, a.slug AS assessment_slug
       FROM candidates c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN assessment_sessions s ON s.candidate_id = c.id
       LEFT JOIN assessments a ON a.id = s.assessment_id
      ORDER BY c.created_at DESC, s.id DESC`
  ).all();

  // rows arrive newest-session-first per candidate (ORDER BY ... s.id DESC)
  const sessionsByCandidate = new Map();
  for (const r of rows) {
    if (r.session_id == null) continue;
    if (!sessionsByCandidate.has(r.id)) sessionsByCandidate.set(r.id, []);
    sessionsByCandidate.get(r.id).push({
      id: r.session_id,
      status: r.status,
      started_at: r.started_at,
      final_submitted_at: r.final_submitted_at,
      assessmentId: r.assessment_id,
      assessmentTitle: r.assessment_title,
      assessmentSlug: r.assessment_slug,
      isPython: isPythonAssessment(r.assessment_slug)
    });
  }

  // one entry per candidate (latest session wins — candidates may hold several
  // sessions, e.g. the cybersecurity test plus a generated Python assessment)
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ ...r, sessions: sessionsByCandidate.get(r.id) || [] });
  }
  res.json({ candidates: out });
});

// ---- create candidate (+ assessment session) ----
adminRouter.post('/candidates', requireRole('admin'), (req, res) => {
  const { name, email = '', position = 'Cybersecurity Intern' } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.length > 80) {
    return res.status(400).json({ error: 'INVALID_NAME' });
  }
  const baseUsername = 'cand' + Math.random().toString(36).slice(2, 7);
  const username = typeof req.body.username === 'string' && /^[a-z0-9_]{3,24}$/.test(req.body.username)
    ? req.body.username : baseUsername;
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'USERNAME_TAKEN' });
  }
  const password = genPassword();
  const t = now();

  const userRes = db.prepare(
    'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(username, hash(password), 'candidate', name.trim(), t);

  const candRes = db.prepare('INSERT INTO candidates (user_id, name, email, position, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userRes.lastInsertRowid, name.trim(), email, position, t);

  // newest active "catalog" assessment wins; per-candidate generated assessments
  // (slug prefix python-degree-intern-) are never auto-assigned to someone else
  const assessment = db.prepare(
    "SELECT id FROM assessments WHERE is_active = 1 AND slug NOT LIKE 'python-degree-intern-%' ORDER BY id DESC LIMIT 1"
  ).get();
  if (assessment) {
    db.prepare(
      'INSERT INTO assessment_sessions (assessment_id, candidate_id, created_by, created_at) VALUES (?, ?, ?, ?)'
    ).run(assessment.id, candRes.lastInsertRowid, req.user.id, t);
    recordEvent({ actorId: req.user.id, type: 'CANDIDATE_CREATED', payload: { username } });
  }

  // The plaintext password is returned exactly once — it is not stored in cleartext anywhere.
  res.json({ ok: true, candidate: { username, oneTimePassword: password, name: name.trim() } });
});

// ---- delete candidate (cascades session, answers, scores, notes, events) ----
adminRouter.delete('/candidates/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const candidate = db.prepare(
    'SELECT c.*, u.username FROM candidates c JOIN users u ON u.id = c.user_id WHERE c.id = ?'
  ).get(id);
  if (!candidate) return res.status(404).json({ error: 'CANDIDATE_NOT_FOUND' });

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM assessment_events WHERE session_id IN (SELECT id FROM assessment_sessions WHERE candidate_id = ?)').run(id);
    db.prepare('DELETE FROM interviewer_notes   WHERE session_id IN (SELECT id FROM assessment_sessions WHERE candidate_id = ?)').run(id);
    db.prepare('DELETE FROM assessment_scores   WHERE session_id IN (SELECT id FROM assessment_sessions WHERE candidate_id = ?)').run(id);
    db.prepare('DELETE FROM assessment_drafts   WHERE session_id IN (SELECT id FROM assessment_sessions WHERE candidate_id = ?)').run(id);
    db.prepare('DELETE FROM assessment_answers  WHERE session_id IN (SELECT id FROM assessment_sessions WHERE candidate_id = ?)').run(id);
    db.prepare('DELETE FROM assessment_sessions WHERE candidate_id = ?').run(id);
    db.prepare('DELETE FROM candidates WHERE id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(candidate.user_id); // cascades auth_sessions
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'DELETE_FAILED' });
  }
  recordEvent({ actorId: req.user.id, type: 'CANDIDATE_DELETED', payload: { candidateId: id, username: candidate.username } });
  res.json({ ok: true });
});

// ---- full session detail (admin-only view incl. answer keys) ----
adminRouter.get('/assessments/:id', requireRole('admin'), (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;

  const tasks = db.prepare(
    'SELECT * FROM assessment_tasks WHERE assessment_id = ? ORDER BY idx'
  ).all(session.assessment_id);

  const answers = db.prepare(
    'SELECT * FROM assessment_answers WHERE session_id = ? ORDER BY task_id, submission_version'
  ).all(session.id);

  const drafts = db.prepare(
    'SELECT * FROM assessment_drafts WHERE session_id = ?'
  ).all(session.id);

  const scores = db.prepare(
    'SELECT * FROM assessment_scores WHERE session_id = ? ORDER BY id'
  ).all(session.id);

  const notes = db.prepare(
    `SELECT n.*, u.display_name AS author FROM interviewer_notes n JOIN users u ON u.id = n.author_id
      WHERE n.session_id = ? ORDER BY n.created_at`
  ).all(session.id);

  const events = db.prepare(
    'SELECT event_type, task_id, payload, created_at, actor_id FROM assessment_events WHERE session_id = ? ORDER BY created_at, id'
  ).all(session.id);

  const answerByTask = new Map();
  for (const a of answers) {
    const row = { ...a };
    try { row.autograde = a.autograde ? JSON.parse(a.autograde) : null; } catch { row.autograde = null; }
    delete row.autograde_raw;
    if (!answerByTask.has(a.task_id)) answerByTask.set(a.task_id, []);
    answerByTask.get(a.task_id).push(row);
  }
  const draftByTask = new Map(drafts.map(d => [d.task_id, d]));

  const sections = db.prepare(
    'SELECT code, label, max_score, idx FROM assessment_score_sections WHERE assessment_id = ? ORDER BY idx'
  ).all(session.assessment_id);

  const scoreMap = new Map(scores.map(s => [s.section_code, s]));
  let total = 0;
  let allScored = sections.length > 0;
  const sectionView = sections.map(sec => {
    const s = scoreMap.get(sec.code);
    const val = s && s.score != null ? s.score : null;
    if (val == null) allScored = false;
    else total += val;
    return {
      code: sec.code, label: sec.label, maxScore: sec.max_score,
      score: val, isOverride: !!(s && s.is_override), updateCount: s ? s.update_count : 0
    };
  });
  const finalScore = allScored ? total : null;
  const isPython = isPythonAssessment(session.assessment_slug);
  const autoRec = isPython ? pythonRecommendationFor(finalScore) : recommendationFor(finalScore);
  const finalRecommendation = session.final_recommendation_ext || session.final_recommendation || autoRec;

  // Python module extras: claimed skills + verification (computed & persisted on the fly)
  let skillResults = null, candidateSkills = null;
  if (isPython) {
    candidateSkills = db.prepare(
      'SELECT skill_name, claimed_level, source, created_at FROM candidate_skills WHERE candidate_id = ? ORDER BY id'
    ).all(session.candidate_id).map(r => ({
      skillName: r.skill_name, claimedLevel: r.claimed_level, source: r.source, createdAt: r.created_at
    }));
    skillResults = buildSkillVerification(session);
  }

  res.json({
    session: {
      id: session.id,
      status: session.status,
      candidateName: session.candidate_name,
      candidateEmail: session.candidate_email,
      candidatePosition: session.candidate_position,
      assessmentTitle: session.assessment_title,
      startedAt: session.started_at,
      deadlineAt: session.deadline_at,
      completedAt: session.completed_at,
      finalSubmittedAt: session.final_submitted_at,
      reviewedAt: session.reviewed_at,
      followupRevealedAt: session.followup_revealed_at,
      durationSeconds: session.duration_seconds,
      serverNow: now(),
      isPython,
      finalRecommendation,
      autoRecommendation: autoRec,
      scoreLevel: isPython ? scoreLevelFor(finalScore) : null,
      recommendationOptions: isPython ? PY_RECOMMENDATION_OPTIONS : null
    },
    tasks: tasks.map(t => ({
      id: t.id, idx: t.idx, code: t.code, title: t.title, type: t.type,
      promptHtml: t.prompt_html, dataText: t.data_text,
      explanationRequired: !!t.explanation_required,
      unlockMode: t.unlock_mode,
      maxScore: t.max_score,
      sectionCode: t.section_code,
      skillName: t.skill_name,
      answerOptions: t.answer_options ? JSON.parse(t.answer_options) : null,
      answerKey: t.answer_key,          // admin only
      scoringGuide: t.scoring_guide,    // admin only
      internalAnswer: t.internal_answer, // admin only
      answers: answerByTask.get(t.id) || [],
      draft: draftByTask.get(t.id) || null
    })),
    sections: sectionView,
    totalScore: finalScore,
    maxTotal: sections.reduce((acc, s) => acc + s.max_score, 0),
    recommendation: finalRecommendation,
    candidateSkills,
    skillResults,
    notes,
    events,
    integrityIndicators: computeIndicators(session)
  });
});

// ---- reveal hidden follow-up ----
adminRouter.post('/assessments/:id/unlock-task', requireRole('admin'), (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  const { action } = req.body || {};
  if (action !== 'reveal_followup') return res.status(400).json({ error: 'UNKNOWN_ACTION' });
  if (session.followup_revealed_at) return res.status(409).json({ error: 'ALREADY_REVEALED' });
  if (!['IN_PROGRESS', 'SUBMITTED', 'TIME_EXPIRED'].includes(session.status)) {
    return res.status(409).json({ error: 'INVALID_STATUS', status: session.status });
  }
  const t = now();
  db.prepare('UPDATE assessment_sessions SET followup_revealed_at = ?, followup_revealed_by = ? WHERE id = ?')
    .run(t, req.user.id, session.id);
  recordEvent({ sessionId: session.id, actorId: req.user.id, type: 'FOLLOWUP_REVEALED' });
  res.json({ ok: true, revealedAt: t });
});

// ---- score a section (server-side; supports overrides) ----
adminRouter.post('/assessments/:id/score', requireRole('admin'), (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  const { sectionCode, score } = req.body || {};
  const section = db.prepare(
    'SELECT * FROM assessment_score_sections WHERE assessment_id = ? AND code = ?'
  ).get(session.assessment_id, sectionCode);
  if (!section) return res.status(404).json({ error: 'SECTION_NOT_FOUND' });
  const val = Number(score);
  if (!Number.isInteger(val) || val < 0 || val > section.max_score) {
    return res.status(400).json({ error: 'INVALID_SCORE', max: section.max_score });
  }
  const existing = db.prepare('SELECT * FROM assessment_scores WHERE session_id = ? AND section_code = ?')
    .get(session.id, sectionCode);
  if (existing) {
    const updateCount = existing.update_count + 1;
    const isOverride = updateCount > 1 ? 1 : existing.is_override;
    db.prepare(
      'UPDATE assessment_scores SET score = ?, is_override = ?, update_count = ?, updated_by = ?, updated_at = ? WHERE id = ?'
    ).run(val, isOverride, updateCount, req.user.id, now(), existing.id);
    recordEvent({
      sessionId: session.id, actorId: req.user.id, type: 'SCORE_UPDATED',
      payload: { sectionCode, score: val, isOverride: !!isOverride }
    });
  } else {
    db.prepare(
      'INSERT INTO assessment_scores (session_id, section_code, max_score, score, is_override, update_count, updated_by, updated_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?)'
    ).run(session.id, sectionCode, section.max_score, val, req.user.id, now());
    recordEvent({ sessionId: session.id, actorId: req.user.id, type: 'SCORE_SET', payload: { sectionCode, score: val } });
  }
  res.json({ ok: true });
});

// ---- interviewer notes ----
adminRouter.post('/assessments/:id/notes', requireRole('admin'), (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  const { note, sectionCode = null } = req.body || {};
  if (!note || typeof note !== 'string' || note.trim().length < 1 || note.length > 5000) {
    return res.status(400).json({ error: 'INVALID_NOTE' });
  }
  db.prepare('INSERT INTO interviewer_notes (session_id, author_id, section_code, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(session.id, req.user.id, sectionCode, note.trim(), now());
  recordEvent({ sessionId: session.id, actorId: req.user.id, type: 'NOTE_ADDED', payload: { sectionCode } });
  res.json({ ok: true });
});

// ---- finalize / override recommendation ----
adminRouter.post('/assessments/:id/finalize', requireRole('admin'), (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  const { recommendation = null } = req.body || {};
  const baseAllowed = ['STRONG_PASS', 'PASS', 'REVIEW', 'FAIL', null];
  const pyOption = PY_RECOMMENDATION_OPTIONS.find(o => o.value === recommendation);
  if (!baseAllowed.includes(recommendation) && !pyOption) {
    return res.status(400).json({ error: 'INVALID_RECOMMENDATION' });
  }
  const t = now();
  // Python-specific recommendations are stored exactly in the ext column and
  // mapped onto the generic 4-value enum for backwards compatibility.
  const base = pyOption ? pyOption.mapTo : recommendation;
  const ext = pyOption ? pyOption.value : null;
  db.prepare(
    "UPDATE assessment_sessions SET status = 'REVIEWED', reviewed_at = ?, final_recommendation = ?, final_recommendation_ext = ? WHERE id = ?"
  ).run(t, base, ext, session.id);
  recordEvent({
    sessionId: session.id, actorId: req.user.id, type: 'ASSESSMENT_FINALIZED',
    payload: { recommendation: ext || base }
  });
  res.json({ ok: true });
});

// ---- configurable recommendation thresholds ----
adminRouter.get('/settings', requireRole('admin'), (req, res) => {
  res.json({
    thresholds: {
      strongPass: Number(getSetting('threshold_strong_pass', '85')),
      pass: Number(getSetting('threshold_pass', '70')),
      review: Number(getSetting('threshold_review', '55'))
    }
  });
});

adminRouter.post('/settings', requireRole('admin'), (req, res) => {
  const { strongPass, pass, review } = req.body?.thresholds || {};
  for (const [k, v] of [['threshold_strong_pass', strongPass], ['threshold_pass', pass], ['threshold_review', review]]) {
    if (!Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 100) {
      return res.status(400).json({ error: 'INVALID_THRESHOLD', key: k });
    }
    setSetting(k, Number(v));
  }
  res.json({ ok: true });
});

// ==================== Python Technical Assessment ====================

// catalog for the "New Python assessment" dialog
adminRouter.get('/python-assessments/catalog', requireRole('admin'), (req, res) => {
  const pool = db.prepare(
    `SELECT category, COUNT(*) AS count FROM question_bank WHERE is_active = 1 AND is_hidden = 0 GROUP BY category`
  ).all();
  const followups = db.prepare(
    'SELECT COUNT(*) AS c FROM question_bank WHERE is_active = 1 AND is_hidden = 1'
  ).get().c;
  res.json({
    title: 'Degree Intern — Python Technical Assessment',
    modes: Object.entries(ASSESSMENT_MODES).map(([value, label]) => ({ value, label })),
    skills: SKILL_CATALOG,
    levels: ['beginner', 'intermediate', 'advanced', 'expert'],
    dimensions: DIMENSIONS,
    defaultSectionCounts: DEFAULT_SECTION_COUNTS,
    questionPool: pool,
    hiddenFollowups: followups
  });
});

// generate (and assign) a Python assessment for a candidate
adminRouter.post('/python-assessments', requireRole('admin'), (req, res) => {
  const { candidateId, mode = 'cv_skill', randomize, durationSeconds, perSection, skills } = req.body || {};
  const cid = Number(candidateId);
  if (!Number.isInteger(cid) || cid <= 0) return res.status(400).json({ error: 'INVALID_CANDIDATE' });
  try {
    const result = createPythonAssessment({
      adminId: req.user.id, candidateId: cid,
      mode: String(mode), randomize: randomize !== false,
      durationSeconds: Number(durationSeconds) || 1800,
      perSection: perSection && typeof perSection === 'object' ? perSection : null,
      skills: Array.isArray(skills) ? skills : null
    });
    // Stranded-session visibility: if the candidate still has an active session
    // on a DIFFERENT assessment, warn the admin — the candidate's screen only
    // ever shows the newest session, so the other one is set aside (creation
    // still succeeds).
    const otherActive = db.prepare(
      `SELECT s.status, a.title
         FROM assessment_sessions s JOIN assessments a ON a.id = s.assessment_id
        WHERE s.candidate_id = ? AND s.assessment_id != ? AND s.status IN ('IN_PROGRESS','SUBMITTED')
        ORDER BY s.id DESC LIMIT 1`
    ).get(cid, result.assessmentId);
    const payload = { ok: true, ...result };
    if (otherActive) {
      payload.warning = `The candidate already has an active session (status ${otherActive.status}) on "${otherActive.title}". ` +
        `The candidate's screen will now show the new Python assessment and the other session is set aside.`;
    }
    res.json(payload);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// candidate skill profile (CV claims)
adminRouter.get('/candidates/:id/skills', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const candidate = db.prepare('SELECT id FROM candidates WHERE id = ?').get(id);
  if (!candidate) return res.status(404).json({ error: 'CANDIDATE_NOT_FOUND' });
  res.json({
    skills: db.prepare('SELECT skill_name, claimed_level, source, created_at FROM candidate_skills WHERE candidate_id = ? ORDER BY id')
      .all(id).map(r => ({ skillName: r.skill_name, claimedLevel: r.claimed_level, source: r.source, createdAt: r.created_at }))
  });
});

adminRouter.put('/candidates/:id/skills', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const candidate = db.prepare('SELECT id FROM candidates WHERE id = ?').get(id);
  if (!candidate) return res.status(404).json({ error: 'CANDIDATE_NOT_FOUND' });
  const { skills } = req.body || {};
  if (!Array.isArray(skills) || skills.length > 40) return res.status(400).json({ error: 'INVALID_SKILLS' });
  const catalog = new Set(SKILL_CATALOG);
  const rows = [];
  for (const s of skills) {
    const name = String(s?.skillName || '').trim();
    if (!name || name.length > 40) return res.status(400).json({ error: 'INVALID_SKILLS' });
    const level = String(s?.claimedLevel || 'intermediate');
    if (!['beginner', 'intermediate', 'advanced', 'expert'].includes(level)) {
      return res.status(400).json({ error: 'INVALID_LEVEL', skill: name });
    }
    rows.push([name, level]);
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM candidate_skills WHERE candidate_id = ?').run(id);
    const ins = db.prepare('INSERT INTO candidate_skills (candidate_id, skill_name, claimed_level, source, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const [name, level] of rows) ins.run(id, name, level, catalog.has(name) ? 'admin' : 'admin_custom', now());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'SKILLS_UPDATE_FAILED' });
  }
  recordEvent({ actorId: req.user.id, type: 'SKILL_PROFILE_UPDATED', payload: { candidateId: id, count: rows.length } });
  res.json({ ok: true, skills: rows.map(([skillName, claimedLevel]) => ({ skillName, claimedLevel })) });
});

// ---- printable report ----
adminRouter.get('/assessments/:id/report', requireRole('admin'), (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;

  const sections = db.prepare(
    'SELECT code, label, max_score, idx FROM assessment_score_sections WHERE assessment_id = ? ORDER BY idx'
  ).all(session.assessment_id);
  const scoreRows = db.prepare('SELECT * FROM assessment_scores WHERE session_id = ?').all(session.id);
  const scoreMap = new Map(scoreRows.map(s => [s.section_code, s]));

  let total = 0, allScored = true;
  const sectionView = sections.map(sec => {
    const s = scoreMap.get(sec.code);
    const val = s && s.score != null ? s.score : null;
    if (val == null) allScored = false; else total += val;
    return { code: sec.code, label: sec.label, maxScore: sec.max_score, score: val, isOverride: !!(s && s.is_override) };
  });

  const tasks = db.prepare(
    'SELECT id, idx, title, type, answer_key FROM assessment_tasks WHERE assessment_id = ? ORDER BY idx'
  ).all(session.assessment_id);
  const taskResults = tasks.filter(t => t.unlock_mode !== 'never_candidate').map(t => {
    const versions = db.prepare(
      'SELECT submission_version, submitted_at, time_spent_ms FROM assessment_answers WHERE session_id = ? AND task_id = ? ORDER BY submission_version'
    ).all(session.id, t.id);
    const last = versions[versions.length - 1];
    return { idx: t.idx, title: t.title, submittedVersions: versions.length, lastSubmittedAt: last ? last.submitted_at : null, timeSpentMs: last ? last.time_spent_ms : null };
  });

  const notes = db.prepare(
    'SELECT note, section_code, created_at FROM interviewer_notes WHERE session_id = ? ORDER BY created_at'
  ).all(session.id);

  const finalScore = allScored ? total : null;
  const isPython = isPythonAssessment(session.assessment_slug);
  const autoRec = isPython ? pythonRecommendationFor(finalScore) : recommendationFor(finalScore);
  res.json({
    candidate: session.candidate_name,
    candidatePosition: session.candidate_position,
    assessment: session.assessment_title,
    isPython,
    scoreLevel: isPython ? scoreLevelFor(finalScore) : null,
    status: session.status,
    startedAt: session.started_at,
    finalSubmittedAt: session.final_submitted_at,
    durationUsedMs: session.started_at ? ((session.final_submitted_at || Math.min(now(), session.deadline_at || now())) - session.started_at) : null,
    durationLimitSeconds: session.duration_seconds,
    sections: sectionView,
    totalScore: finalScore,
    maxTotal: sections.reduce((a, s) => a + s.max_score, 0),
    autoRecommendation: autoRec,
    finalRecommendation: session.final_recommendation_ext || session.final_recommendation || autoRec,
    skillResults: isPython ? buildSkillVerification(session) : null,
    taskResults,
    integrityIndicators: computeIndicators(session),
    notes
  });
});

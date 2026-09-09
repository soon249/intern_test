import { db, now, recordEvent } from './db.js';
import { DIMENSIONS, SKILL_CATALOG, SKILL_DIMENSION_MAP, DEFAULT_SECTION_COUNTS } from './pythonQuestions.js';

/**
 * Generator for the "Degree Intern — Python Technical Assessment".
 *
 * Selects questions from question_bank according to the requested mode and the
 * candidate's skill profile, then MATERIALIZES them as ordinary rows in
 * assessment_tasks + assessment_score_sections. Everything downstream (delivery,
 * server-side timer, sequential unlocking, versioned submissions, scoring,
 * report) is the existing engine — unchanged.
 */

export const PYTHON_BASE_SLUG = 'python-degree-intern';
export const PYTHON_TITLE = 'Degree Intern — Python Technical Assessment';

export const PY_RECOMMENDATION_OPTIONS = [
  { value: 'STRONG_FIT', label: 'Strong Fit', mapTo: 'STRONG_PASS' },
  { value: 'SUITABLE', label: 'Suitable', mapTo: 'PASS' },
  { value: 'SUITABLE_WITH_SUPERVISION', label: 'Suitable With Supervision', mapTo: 'REVIEW' },
  { value: 'FURTHER_INTERVIEW', label: 'Further Interview', mapTo: 'REVIEW' },
  { value: 'NOT_RECOMMENDED', label: 'Not Recommended', mapTo: 'FAIL' }
];

// Dimensions always tested (general baseline). Everything else only if claimed.
const CORE_DIMENSIONS = ['FUNDAMENTALS', 'DATA_PROCESSING', 'DEBUGGING', 'PROBLEM_SOLVING', 'EXPLANATION'];
const SKILLED_DIMENSIONS = {
  CSV_PANDAS: ['Pandas', 'CSV Processing', 'Data Analysis'],
  WEB_API: ['Requests', 'API'],
  SCRAPING: ['Web Scraping']
};

export const ASSESSMENT_MODES = {
  standard: 'Standard Assessment — fixed question sequence',
  cv_skill: 'CV Skill Assessment — generated from the candidate\'s claimed skills',
  interview_followup: 'Interview Follow-Up — short practical set; follow-ups are asked verbally by the interviewer'
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dimensionsForMode(mode, claimedSkills) {
  if (mode === 'standard') return DIMENSIONS.map(d => d.code);
  if (mode === 'interview_followup') return ['FUNDAMENTALS', 'DEBUGGING', 'PROBLEM_SOLVING'];
  // claimedSkills entries may be strings or {skillName, claimedLevel} objects
  const claimed = new Set(claimedSkills.map(s =>
    typeof s === 'string' ? s.toLowerCase() : String((s && s.skillName) || '').toLowerCase()));
  const dims = [...CORE_DIMENSIONS];
  for (const [dim, skills] of Object.entries(SKILLED_DIMENSIONS)) {
    if (skills.some(s => claimed.has(s.toLowerCase())) && !dims.includes(dim)) dims.push(dim);
  }
  return dims;
}

const DIM_WEIGHT = new Map(DIMENSIONS.map(d => [d.code, d.weight]));

function poolsFor(includeDims) {
  const pools = {};
  for (const dim of includeDims) {
    pools[dim] = db.prepare(
      `SELECT * FROM question_bank WHERE category = ? AND is_hidden = 0 AND is_active = 1 ORDER BY id`
    ).all(dim);
  }
  return pools;
}

/**
 * Distribute a requested question total across the included dimensions:
 * every dimension starts with 1 (highest rubric weight first), the remainder is
 * filled proportionally to weight, always clamped to each dimension's pool size.
 */
export function distributeCounts(total, includeDims, pools) {
  const dims = [...includeDims].sort((a, b) => (DIM_WEIGHT.get(b) || 0) - (DIM_WEIGHT.get(a) || 0));
  const counts = Object.fromEntries(includeDims.map(d => [d, 0]));
  let budget = Math.max(0, Math.floor(Number(total) || 0));
  for (const d of dims) {
    if (budget <= 0) break;
    if (pools[d].length > 0) { counts[d] = 1; budget--; }
  }
  for (;;) {
    if (budget <= 0) break;
    const open = dims.filter(d => counts[d] < pools[d].length);
    if (!open.length) break;
    const totalWeight = open.reduce((a, d) => a + (DIM_WEIGHT.get(d) || 0), 0);
    let moved = false;
    for (const d of dims) {
      if (budget <= 0) break;
      if (counts[d] >= pools[d].length) continue;
      const share = Math.max(1, Math.floor(budget * (DIM_WEIGHT.get(d) || 0) / totalWeight));
      const add = Math.min(share, pools[d].length - counts[d], budget);
      if (add > 0) { counts[d] += add; budget -= add; moved = true; }
    }
    if (!moved) break;
  }
  return counts;
}

/**
 * Pure planner: picks questions per dimension according to perSection overrides,
 * an explicit totalQuestions target, or the built-in defaults. No writes.
 */
export function planSelection({ mode = 'cv_skill', claimedSkills = [], randomize = true, perSection = null, totalQuestions = null }) {
  const includeDims = dimensionsForMode(mode, claimedSkills);
  const pools = poolsFor(includeDims);

  let counts;
  if (perSection && typeof perSection === 'object') {
    counts = {};
    for (const d of includeDims) {
      const want = Number(perSection[d] ?? DEFAULT_SECTION_COUNTS[d] ?? 1);
      counts[d] = Math.max(0, Math.min(Number.isFinite(want) ? Math.floor(want) : 1, pools[d].length));
    }
  } else if (totalQuestions != null && Number(totalQuestions) > 0) {
    counts = distributeCounts(totalQuestions, includeDims, pools);
  } else {
    counts = {};
    for (const d of includeDims) counts[d] = Math.min(Number(DEFAULT_SECTION_COUNTS[d] ?? 1) || 0, pools[d].length);
  }

  const followupsByParent = new Map();
  for (const f of db.prepare(
    `SELECT * FROM question_bank WHERE is_hidden = 1 AND is_active = 1 AND followup_of IS NOT NULL ORDER BY id`
  ).all()) {
    if (!followupsByParent.has(f.followup_of)) followupsByParent.set(f.followup_of, []);
    followupsByParent.get(f.followup_of).push(f);
  }

  const selected = []; // {question, followups:[...]}
  for (const dim of includeDims) {
    const want = counts[dim];
    if (!want) continue;
    let pool = pools[dim];
    if (randomize) pool = shuffle(pool);
    for (const q of pool.slice(0, want)) {
      selected.push({ question: q, followups: followupsByParent.get(q.code) || [] });
    }
  }
  const followupCount = selected.reduce((a, s) => a + s.followups.length, 0);
  return { includeDims, pools, counts, selected, followupCount, questionCount: selected.length };
}

/**
 * Read-only preview of a would-be generation: per-section plan, hidden
 * follow-up estimate and a suggested duration. Used by the admin dialog so the
 * interviewer sees exactly what they are about to create.
 */
export function previewPythonAssessment({ mode = 'cv_skill', claimedSkills = [], perSection = null, totalQuestions = null }) {
  const plan = planSelection({ mode, claimedSkills, randomize: false, perSection, totalQuestions });
  const labels = new Map(DIMENSIONS.map(d => [d.code, d.label]));
  return {
    mode,
    sections: plan.includeDims.map(d => ({
      code: d, label: labels.get(d) || d,
      selected: plan.counts[d], poolSize: plan.pools[d].length
    })),
    questionCount: plan.questionCount,
    followupCount: plan.followupCount,
    taskCountEstimate: plan.questionCount + plan.followupCount,
    suggestedMinutes: Math.max(15, Math.round(plan.questionCount * 2.3))
  };
}

export function createPythonAssessment({ adminId, candidateId, mode = 'cv_skill', randomize = true, durationSeconds = 1800, perSection = null, totalQuestions = null, skills = null }) {
  const candidate = db.prepare(
    `SELECT c.*, u.username FROM candidates c JOIN users u ON u.id = c.user_id WHERE c.id = ?`
  ).get(candidateId);
  if (!candidate) throw Object.assign(new Error('CANDIDATE_NOT_FOUND'), { status: 404 });

  // Resolve the skill profile: explicit list wins and is persisted to the profile.
  let claimedSkills = Array.isArray(skills) ? skills : null;
  if (claimedSkills) {
    db.prepare('DELETE FROM candidate_skills WHERE candidate_id = ?').run(candidateId);
    const ins = db.prepare(
      'INSERT INTO candidate_skills (candidate_id, skill_name, claimed_level, source, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const s of claimedSkills) {
      if (!s || typeof s.skillName !== 'string') continue;
      ins.run(candidateId, s.skillName.trim(), String(s.claimedLevel || 'intermediate'), 'admin', now());
    }
  }
  if (!claimedSkills) {
    claimedSkills = db.prepare('SELECT skill_name, claimed_level FROM candidate_skills WHERE candidate_id = ?')
      .all(candidateId).map(r => ({ skillName: r.skill_name, claimedLevel: r.claimed_level }));
  }

  const modeInfo = ASSESSMENT_MODES[mode];
  if (!modeInfo) throw Object.assign(new Error('INVALID_MODE'), { status: 400 });
  const duration = Number(durationSeconds) >= 300 && Number(durationSeconds) <= 4 * 3600
    ? Math.floor(Number(durationSeconds)) : 1800;
  const durationMinutes = Math.round(duration / 60);

  // ---- question selection ----
  const plan = planSelection({ mode, claimedSkills, randomize, perSection, totalQuestions });
  const { selected } = plan;
  const questionCount = plan.questionCount;
  if (questionCount < 3) throw Object.assign(new Error('NOT_ENOUGH_QUESTIONS'), { status: 409 });

  // ---- rubric: rescale dimension weights so the total is exactly 100 ----
  const hasQuestions = new Set(selected.map(s => s.question.category));
  const rubricDims = DIMENSIONS.filter(d => d.code === 'CODE_QUALITY'
    ? selected.some(s => s.question.code_editor === 1)   // code quality is scored on real code submissions
    : hasQuestions.has(d.code));
  const weightSum = rubricDims.reduce((a, d) => a + d.weight, 0);
  let remaining = 100;
  const rubric = rubricDims.map((d, i) => {
    const max = i === rubricDims.length - 1 ? remaining : Math.max(1, Math.round((d.weight / weightSum) * 100));
    remaining -= max;
    return { ...d, maxScore: max };
  });

  // ---- create assessment + tasks + sections + session ----
  const t = now();
  const slug = `${PYTHON_BASE_SLUG}-${candidate.id}-${t}`;
  const claimedLine = claimedSkills.map(s => `${s.skillName} (${s.claimedLevel})`).join(', ') || 'no skills recorded';
  const assessmentRes = db.prepare(
    `INSERT INTO assessments (slug, title, description, instructions, duration_seconds, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(
    slug, PYTHON_TITLE,
    `Python technical assessment for ${candidate.name}. Mode: ${modeInfo}`,
    JSON.stringify({
      intro: [
        `This Python assessment lasts ${durationMinutes} minutes (unless your interviewer told you otherwise). One countdown runs for the whole assessment.`,
        'You will answer questions one at a time. The next question appears only after you submit the current one — you cannot look ahead.',
        'Question types: multiple choice, short answers, and practical Python coding. Write code that solves the problem; it is reviewed by a human, not executed.',
        'Your code and answers are auto-saved as you type. Press "Save" manually at any time.',
        'Some questions include follow-up requirement changes after you submit — read them carefully and adapt your answer.',
        'For the final question, explain your solution in your own words.',
        'When the timer reaches 00:00 you can no longer submit. Everything you saved is preserved for review.',
        'Do not use AI tools or other tabs. Your claimed skills are: ' + claimedLine + '.'
      ]
    }),
    duration, t
  );
  const assessmentId = assessmentRes.lastInsertRowid;

  const insertTask = db.prepare(
    `INSERT INTO assessment_tasks
       (assessment_id, idx, code, title, type, prompt_html, data_text, starter_code, answer_options,
        explanation_required, code_editor, answer_key, scoring_guide, internal_answer, unlock_mode, max_score,
        section_code, skill_name, question_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let idx = 0;
  for (const { question: q, followups } of selected) {
    // MCQ materialises as a scenario-type task with answer_options (candidate UI renders radios)
    const type = q.qtype === 'code' ? 'code' : 'scenario';
    insertTask.run(
      assessmentId, idx++, q.code, q.title, type, q.prompt_html, q.data_text, q.starter_code,
      q.answer_options, q.explanation_required ? 1 : 0, q.code_editor ? 1 : 0,
      q.answer_key, q.scoring_guide, q.internal_answer, 'after_previous', q.points,
      q.category, q.skill_name, q.id
    );
    for (const f of followups) {
      // MODE 3: interviewer asks follow-ups verbally — candidates never see them in the UI.
      insertTask.run(
        assessmentId, idx++, f.code, f.title,
        mode === 'interview_followup' ? 'interviewer_only' : f.qtype === 'code' ? 'code' : 'scenario',
        f.prompt_html, f.data_text, f.starter_code, f.answer_options,
        f.explanation_required ? 1 : 0, f.code_editor ? 1 : 0,
        f.answer_key, f.scoring_guide, f.internal_answer,
        mode === 'interview_followup' ? 'never_candidate' : 'after_previous', f.points,
        f.category, f.skill_name, f.id
      );
    }
  }

  const insertSection = db.prepare(
    'INSERT INTO assessment_score_sections (assessment_id, code, label, max_score, idx) VALUES (?, ?, ?, ?, ?)'
  );
  rubric.forEach((d, i) => insertSection.run(assessmentId, d.code, `${d.label}`, d.maxScore, i));

  const insertMapping = db.prepare(
    'INSERT INTO assessment_skill_mapping (assessment_id, skill_name, weight) VALUES (?, ?, ?)'
  );
  for (const d of rubric) insertMapping.run(assessmentId, d.code, d.weight);

  const sessionRes = db.prepare(
    'INSERT INTO assessment_sessions (assessment_id, candidate_id, created_by, created_at) VALUES (?, ?, ?, ?)'
  ).run(assessmentId, candidateId, adminId, t);

  recordEvent({
    sessionId: sessionRes.lastInsertRowid, actorId: adminId, type: 'PYTHON_ASSESSMENT_CREATED',
    payload: { mode, randomize, durationSeconds: duration, questionCount, skills: claimedSkills }
  });

  return {
    assessmentId, sessionId: sessionRes.lastInsertRowid,
    questionCount, followupCount: plan.followupCount, taskCount: idx, mode, durationSeconds: duration,
    rubric: rubric.map(r => ({ code: r.code, label: r.label, maxScore: r.maxScore }))
  };
}

// ---- scoring levels (spec §19) ----
export function scoreLevelFor(percent) {
  if (percent == null) return null;
  if (percent >= 90) return { label: 'Excellent', cls: 'green' };
  if (percent >= 75) return { label: 'Strong', cls: 'green' };
  if (percent >= 60) return { label: 'Acceptable', cls: 'blue' };
  if (percent >= 40) return { label: 'Weak', cls: 'amber' };
  return { label: 'Insufficient', cls: 'red' };
}

export function pythonRecommendationFor(percent) {
  if (percent == null) return null;
  if (percent >= 90) return 'STRONG_FIT';
  if (percent >= 75) return 'SUITABLE';
  if (percent >= 60) return 'SUITABLE_WITH_SUPERVISION';
  if (percent >= 40) return 'FURTHER_INTERVIEW';
  return 'NOT_RECOMMENDED';
}

export function isPythonAssessment(slug) {
  return typeof slug === 'string' && slug.startsWith(PYTHON_BASE_SLUG);
}

/**
 * Claimed-skill verification (spec §20/§21).
 * Scored dimensions → VERIFIED (≥75%) / PARTIALLY_VERIFIED (≥50%) / NOT_VERIFIED.
 * Claimed skills without any mapped question → NOT_TESTED (explicitly NOT "does not know it").
 * "Advanced"-level claims on weak fundamentals get a requires-review note; the
 * wording never accuses the candidate — judgement stays with the interviewer.
 */
export function buildSkillVerification(session) {
  const sections = db.prepare(
    'SELECT code, label, max_score FROM assessment_score_sections WHERE assessment_id = ? ORDER BY idx'
  ).all(session.assessment_id);
  const sectionMax = new Map(sections.map(s => [s.code, s.max_score]));

  const scoreRows = db.prepare('SELECT section_code, score FROM assessment_scores WHERE session_id = ?').all(session.id);
  const scoreByDim = new Map(scoreRows.map(r => [r.section_code, r.score]));

  const claimed = db.prepare(
    `SELECT skill_name, claimed_level FROM candidate_skills WHERE candidate_id = ?`
  ).all(session.candidate_id);

  const out = [];
  for (const skill of claimed) {
    const dims = SKILL_DIMENSION_MAP[skill.skill_name] || [];
    const tested = dims.filter(d => sectionMax.has(d));
    let status = 'NOT_TESTED';
    let score = null, maxScore = null, note = null;

    if (!tested.length) {
      note = 'No assessment questions covered this skill — NOT TESTED does not mean the candidate does not know it.';
    } else {
      maxScore = tested.reduce((a, d) => a + sectionMax.get(d), 0);
      const scored = tested.filter(d => scoreByDim.get(d) != null);
      if (!scored.length) {
        note = 'Covered by the assessment; scoring pending.';
      } else {
        score = scored.reduce((a, d) => a + scoreByDim.get(d), 0);
        const percent = (score / maxScore) * 100;
        status = percent >= 75 ? 'VERIFIED' : percent >= 50 ? 'PARTIALLY_VERIFIED' : 'NOT_VERIFIED';
        const lvl = String(skill.claimed_level || '').toLowerCase();
        if ((lvl === 'advanced' || lvl === 'expert') && percent < 60) {
          note = `Claimed ${lvl} proficiency but demonstrated ${Math.round(percent)}% on the related sections — Claimed Skill vs Demonstrated Skill requires review (interviewer judgement).`;
        } else {
          note = `Demonstrated ${Math.round(percent)}% on: ${tested.join(', ')}.`;
        }
      }
    }

    out.push({
      skillName: skill.skill_name, claimedLevel: skill.claimed_level,
      status, score, maxScore, notes: note
    });
  }

  persistSkillResults(session, out);
  return out;
}

function persistSkillResults(session, results) {
  const t = now();
  const upsert = db.prepare(
    `INSERT INTO assessment_skill_results
       (assessment_id, session_id, skill_name, claimed_level, score, max_score, verification_status, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, skill_name) DO UPDATE SET
       claimed_level = excluded.claimed_level, score = excluded.score, max_score = excluded.max_score,
       verification_status = excluded.verification_status, notes = excluded.notes, updated_at = excluded.updated_at`
  );
  for (const r of results) {
    upsert.run(session.assessment_id, session.id, r.skillName, r.claimedLevel, r.score, r.maxScore, r.status, r.notes, t);
  }
}

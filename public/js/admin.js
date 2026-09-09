'use strict';

// Interviewer dashboard. This is the only surface that receives answer keys,
// scoring guides and internal answers — the API rejects non-admin callers.

let currentSessionId = null;
let detail = null;
let selectedCandidateId = null;

const $main = document.getElementById('main');
const $list = document.getElementById('cand-list');

// CSP-safe error-box helpers (class toggling instead of inline styles)
function clearErr(el) { el.classList.remove('show'); }
function setErr(el, msg) { el.textContent = msg || ''; el.classList.add('show'); }

(async function init() {
  try {
    const me = await api('/api/auth/me');
    if (me.role !== 'admin') { location.href = me.role === 'candidate' ? '/candidate' : '/'; return; }
    document.getElementById('me').textContent = me.displayName;
  } catch { location.href = '/'; return; }

  document.getElementById('logout').onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.href = '/';
  };

  await loadCandidates();
  setInterval(() => { loadCandidates(); if (currentSessionId) loadDetail(currentSessionId, true); }, 5000);

  // new candidate modal
  const ncBack = document.getElementById('nc-back');
  document.getElementById('new-candidate').onclick = () => {
    ncBack.classList.add('open');
    clearErr(document.getElementById('nc-err'));
  };
  document.getElementById('nc-cancel').onclick = () => ncBack.classList.remove('open');
  document.getElementById('nc-ok').onclick = createCandidate;

  document.getElementById('otp-close').onclick = () => document.getElementById('otp-back').classList.remove('open');
  document.getElementById('otp-copy').onclick = () => {
    navigator.clipboard.writeText(document.getElementById('otp-body').dataset.pw || '').then(() => toast('Password copied'));
  };
  document.getElementById('rep-close').onclick = () => document.getElementById('rep-back').classList.remove('open');
  document.getElementById('rep-print').onclick = () => window.print();

  // python assessment modal
  document.getElementById('new-python').onclick = () => openPyModal();
  document.getElementById('py-cancel').onclick = () => document.getElementById('py-back').classList.remove('open');
  document.getElementById('py-skill-add').onclick = addSkillRow;
  document.getElementById('py-ok').onclick = createPythonAssessment;
  document.getElementById('py-save-skills').onclick = saveSkillsOnly;
  document.getElementById('py-candidate').onchange = () => { loadSkillRows(document.getElementById('py-candidate').value); refreshPyPreview(); };
  document.getElementById('py-mode').addEventListener('change', () => { updateModeHint(); refreshPyPreview(); });
  document.getElementById('py-count').addEventListener('input', refreshPyPreview);
})();

// ---------- python assessment / skill profile ----------
let pyCatalog = null;
let pyPreviewTimer = null;

const PY_MODE_HINTS = {
  cv_skill: "Questions are generated only for the candidate's claimed skills, plus general baselines. Profiled skills that are not assessed stay NOT TESTED.",
  standard: 'Fixed question sequence covering every rubric section — best for comparing candidates on the same baseline.',
  interview_followup: 'Short question set for a live session; ask deeper follow-ups verbally and record them as interviewer notes.'
};

const PY_SECTION_SHORT = {
  FUNDAMENTALS: 'Fund', DATA_PROCESSING: 'Data', CSV_PANDAS: 'CSV', DEBUGGING: 'Debug',
  WEB_API: 'API', SCRAPING: 'Scrape', PROBLEM_SOLVING: 'Practical', CODE_QUALITY: 'Quality', EXPLANATION: 'Explain'
};

function updateModeHint() {
  const hint = document.getElementById('py-mode-hint');
  if (hint) hint.textContent = PY_MODE_HINTS[document.getElementById('py-mode').value] || '';
}

// live composition preview: asks the server what WOULD be generated with the
// current candidate / mode / question count — nothing is created
async function refreshPyPreview() {
  const box = document.getElementById('py-preview');
  if (!box) return;
  clearTimeout(pyPreviewTimer);
  pyPreviewTimer = setTimeout(async () => {
    try {
      const r = await api('/api/admin/python-assessments/preview', {
        method: 'POST',
        body: {
          candidateId: Number(document.getElementById('py-candidate').value) || undefined,
          mode: document.getElementById('py-mode').value,
          totalQuestions: document.getElementById('py-count').value || null
        }
      });
      if (!r.sections.length) {
        box.hidden = true;
        return;
      }
      const chips = r.sections.map(s =>
        `<span class="py-chip${s.selected >= s.poolSize ? ' capped' : ''}" title="${esc(s.label)}: ${s.selected} of ${s.poolSize} in pool">
          ${esc(PY_SECTION_SHORT[s.code] || s.label)} ${s.selected}<span class="cap">/${s.poolSize}</span>
        </span>`).join('');
      const extras = [];
      if (r.followupCount) extras.push(`+${r.followupCount} hidden follow-ups`);
      extras.push(`≈${r.taskCountEstimate} tasks`);
      extras.push(`suggested ${r.suggestedMinutes} min`);
      box.innerHTML = `${chips}<span class="py-preview-meta">${esc(extras.join(' · '))}</span>`;
      box.hidden = false;
    } catch {
      box.hidden = true;
    }
  }, 250);
}

async function loadPyCatalog() {
  if (pyCatalog) return pyCatalog;
  try {
    pyCatalog = await api('/api/admin/python-assessments/catalog');
  } catch { pyCatalog = { skills: [], modes: [] }; }
  const sel = document.getElementById('py-add-skill');
  sel.innerHTML = (pyCatalog.skills || []).map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('') +
    '<option value="__other">Other (custom)…</option>';
  return pyCatalog;
}

async function openPyModal(candidateId = null) {
  await loadPyCatalog();
  const { candidates } = await api('/api/admin/candidates');
  const sel = document.getElementById('py-candidate');
  sel.innerHTML = candidates.map(c =>
    `<option value="${c.id}">${esc(c.name)} (${esc(c.username)})</option>`).join('');
  if (candidateId) sel.value = String(candidateId);
  clearErr(document.getElementById('py-err'));
  document.getElementById('py-count').value = '';
  updateModeHint();
  document.getElementById('py-back').classList.add('open');
  await loadSkillRows(sel.value);
  refreshPyPreview();
}

function skillRowHtml(skillName, level) {
  return `<div class="skill-row" data-name="${esc(skillName)}">
    <span class="skill-name">${esc(skillName)}</span>
    <select class="skill-level">
      <option value="beginner" ${level === 'beginner' ? 'selected' : ''}>Beginner</option>
      <option value="intermediate" ${level === 'intermediate' ? 'selected' : ''}>Intermediate</option>
      <option value="advanced" ${level === 'advanced' ? 'selected' : ''}>Advanced</option>
      <option value="expert" ${level === 'expert' ? 'selected' : ''}>Expert</option>
    </select>
    <button class="small skill-del" title="Remove">✕</button>
  </div>`;
}

async function loadSkillRows(candidateId) {
  const box = document.getElementById('py-skills');
  box.innerHTML = '<p class="faint">Loading…</p>';
  let rows = [];
  try {
    const r = await api(`/api/admin/candidates/${candidateId}/skills`);
    rows = r.skills || [];
  } catch { /* none */ }
  box.innerHTML = rows.length
    ? rows.map(s => skillRowHtml(s.skillName, s.claimedLevel)).join('')
    : '<p class="faint">No skills recorded yet — add the candidate\'s claimed skills below.</p>';
  bindSkillRows();
}

function bindSkillRows() {
  document.querySelectorAll('#py-skills .skill-del').forEach(btn => {
    btn.onclick = () => btn.closest('.skill-row').remove();
  });
}

function addSkillRow() {
  const nameSel = document.getElementById('py-add-skill');
  const levelSel = document.getElementById('py-add-level');
  const name = nameSel.value === '__other'
    ? (prompt('Custom skill name:') || '').trim() : nameSel.value;
  if (!name) return;
  const box = document.getElementById('py-skills');
  if (box.querySelector(`.skill-row[data-name="${CSS.escape(name)}"]`)) { toast('Skill already added', true); return; }
  if (box.querySelector('p.faint')) box.innerHTML = '';
  box.insertAdjacentHTML('beforeend', skillRowHtml(name, levelSel.value));
  bindSkillRows();
}

function collectSkills() {
  return [...document.querySelectorAll('#py-skills .skill-row')].map(row => ({
    skillName: row.dataset.name,
    claimedLevel: row.querySelector('.skill-level').value
  }));
}

async function saveSkillsOnly() {
  const err = document.getElementById('py-err');
  clearErr(err);
  try {
    await api(`/api/admin/candidates/${document.getElementById('py-candidate').value}/skills`, {
      method: 'PUT',
      body: { skills: collectSkills() }
    });
    toast('Skill profile saved');
    document.getElementById('py-back').classList.remove('open');
    await loadCandidates();
  } catch (e) {
    setErr(err, e.message || 'Failed');
  }
}

async function createPythonAssessment() {
  const err = document.getElementById('py-err');
  clearErr(err);
  try {
    const countVal = document.getElementById('py-count').value;
    const r = await api('/api/admin/python-assessments', {
      method: 'POST',
      body: {
        candidateId: Number(document.getElementById('py-candidate').value),
        mode: document.getElementById('py-mode').value,
        randomize: document.getElementById('py-randomize').checked,
        durationSeconds: Number(document.getElementById('py-duration').value) * 60,
        totalQuestions: countVal ? Number(countVal) : null,
        skills: collectSkills()
      }
    });
    document.getElementById('py-back').classList.remove('open');
    const fu = r.taskCount - r.questionCount;
    toast(`Python assessment created — ${r.questionCount} questions` +
      (fu > 0 ? ` + ${fu} hidden follow-ups` : '') + ` (${r.taskCount} tasks)`);
    currentSessionId = r.sessionId;
    await loadCandidates();
    await loadDetail(r.sessionId);
  } catch (e) {
    setErr(err, e.message === 'INVALID_TOTAL_QUESTIONS'
      ? 'Question count must be between 3 and 40.' : (e.message || 'Failed'));
  }
}

// ---------- candidates list ----------
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

function assessmentIcon(slug) {
  return (slug || '').startsWith('python-') ? '🐍' : '🛡️';
}

async function loadCandidates() {
  try {
    const { candidates } = await api('/api/admin/candidates');
    if (!candidates.length) {
      $list.innerHTML = '<p class="faint">No candidates yet. Create one to begin.</p>';
      return;
    }
    $list.innerHTML = candidates.map(c => {
      const icon = c.session_id ? assessmentIcon(c.assessment_slug) : '';
      const statusAttr = c.session_id ? esc(c.status || '') : 'NO_SESSION';
      return `
      <div class="cand-item ${c.session_id && c.session_id === currentSessionId ? 'selected' : ''}" data-sid="${c.session_id ?? ''}">
        <span class="cand-avatar" data-status="${statusAttr}" aria-hidden="true">${esc(initials(c.name))}</span>
        <div class="cand-body">
          <div class="cand-name-row">
            <span class="name">${esc(c.name)}</span>
            <span class="cand-tools">
              <button class="cand-skills" data-skills="${c.id}" title="Skills / Python assessment">🐍</button>
            </span>
          </div>
          <div class="meta">${c.session_id ? statusBadge(c.status) : '<span class="badge gray">NO SESSION</span>'}
            <span class="cand-sub">${c.session_id ? `${icon} ${esc(c.assessment_title || '')} · ${timeAgo(c.started_at || c.created_at)}` : esc(c.username)}</span></div>
        </div>
        <button class="cand-del" data-del="${c.id}" title="Delete candidate">✕</button>
      </div>`;
    }).join('');
    $list.querySelectorAll('.cand-item').forEach(el => {
      el.onclick = () => {
        const sid = Number(el.dataset.sid);
        if (!sid) { toast('No assessment session for this candidate', true); return; }
        currentSessionId = sid;
        loadDetail(sid);
      };
    });
    $list.querySelectorAll('.cand-skills').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        await openPyModal(Number(btn.dataset.skills));
      };
    });
    $list.querySelectorAll('.cand-del').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        const id = Number(btn.dataset.del);
        const item = candidates.find(c => c.id === id);
        const ok = await confirmModal({
          title: `Delete ${item ? item.name : 'this candidate'}?`,
          body: 'The candidate account and all submissions, scores, notes and audit events will be permanently removed. This cannot be undone.',
          confirmText: 'Delete permanently',
          danger: true
        });
        if (!ok) return;
        try {
          await api(`/api/admin/candidates/${id}`, { method: 'DELETE' });
          toast('Candidate deleted');
          if (currentSessionId && item && item.session_id === currentSessionId) {
            currentSessionId = null;
            selectedCandidateId = null;
            $main.innerHTML = '<div class="card"><p class="muted">Select a candidate to view their assessment.</p></div>';
          }
          await loadCandidates();
        } catch (err) { toast(err.message || 'Delete failed', true); }
      };
    });
  } catch (e) { if (e.status === 401) location.href = '/'; }
}

function timeAgo(ms) {
  if (!ms) return '';
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function createCandidate() {
  const err = document.getElementById('nc-err');
  clearErr(err);
  try {
    const r = await api('/api/admin/candidates', {
      method: 'POST',
      body: {
        name: document.getElementById('nc-name').value.trim(),
        email: document.getElementById('nc-email').value.trim(),
        position: document.getElementById('nc-position').value.trim()
      }
    });
    document.getElementById('nc-back').classList.remove('open');
    const body = document.getElementById('otp-body');
    body.innerHTML = `Username: <b>${esc(r.candidate.username)}</b><br>One-time password: <b>${esc(r.candidate.oneTimePassword)}</b><br><br><span class="muted">Candidate: ${esc(r.candidate.name)}</span>`;
    body.dataset.pw = r.candidate.oneTimePassword;
    document.getElementById('otp-back').classList.add('open');
    await loadCandidates();
  } catch (e) {
    setErr(err, e.message === 'USERNAME_TAKEN' ? 'Username conflict — try again.' : (e.message || 'Failed'));
  }
}

// ---------- session detail ----------
async function loadDetail(sessionId, quiet = false) {
  try {
    detail = await api(`/api/admin/assessments/${sessionId}`);
    renderDetail();
  } catch (e) {
    if (!quiet) toast('Failed to load session', true);
  }
}

function elapsedView(s) {
  if (!s.startedAt) return '—';
  const end = s.finalSubmittedAt || Math.min(s.serverNow, s.deadlineAt || Infinity);
  const usedMs = Math.max(0, end - s.startedAt);
  return `${fmtClock(usedMs / 1000)} / ${fmtClock(s.durationSeconds)}`;
}

function renderDetail() {
  const s = detail.session;
  $main.innerHTML = `
    <div class="card">
      <div class="detail-head">
        <h1>${esc(s.candidateName)}</h1>
        ${statusBadge(s.status)}
        <span class="muted detail-title">${esc(s.assessmentTitle)}</span>
        ${s.isPython && s.scoreLevel ? `<span class="badge ${s.scoreLevel.cls} badge-lg">LEVEL: ${esc(s.scoreLevel.label.toUpperCase())}</span>` : ''}
        <span class="spacer"></span>
        <button id="btn-report" class="small">Generate report</button>
      </div>
      <div class="stat-row">
        <div class="stat"><div class="k"><span class="k-ic">🕒</span>Start time</div><div class="v mono">${s.startedAt ? fmtTs(s.startedAt) : '—'}</div></div>
        <div class="stat"><div class="k"><span class="k-ic">⏱️</span>Time used</div><div class="v mono">${elapsedView(s)}</div></div>
        <div class="stat"><div class="k"><span class="k-ic">📊</span>Total score</div><div class="v">${detail.totalScore != null ? `${detail.totalScore} / ${detail.maxTotal}` : 'PENDING'}</div></div>
        <div class="stat"><div class="k"><span class="k-ic">⚑</span>Recommendation</div><div class="v">${recBadge(detail.recommendation)}</div></div>
      </div>
    </div>

    <div class="detail-grid">
      <div>
        ${s.isPython ? renderSkillCard() : ''}
        ${renderIntegrityCard()}
        ${renderTaskCards()}
        ${renderNotesCard()}
      </div>
      <div>
        ${renderScoresCard()}
        ${renderTimelineCard()}
      </div>
    </div>`;

  bindDetailActions();
}

const SKILL_STATUS_CLS = {
  VERIFIED: 'green', PARTIALLY_VERIFIED: 'amber', NOT_VERIFIED: 'red', NOT_TESTED: 'gray'
};

function renderSkillCard() {
  const rows = (detail.skillResults || []).map(r => `
    <div class="sv-row">
      <div class="sv-line">
        <span class="sv-name">${esc(r.skillName)}</span>
        <span class="sv-chip">claimed: ${esc(r.claimedLevel || '—')}</span>
        <span class="badge ${SKILL_STATUS_CLS[r.status] || 'gray'}">${esc(r.status.replace(/_/g, ' '))}</span>
        <span class="sv-score">${r.maxScore != null ? `${r.score ?? '—'} / ${r.maxScore}` : '—'}</span>
      </div>
      ${r.notes ? `<div class="sv-notes">${esc(r.notes)}</div>` : ''}
    </div>`).join('');
  const claimed = (detail.candidateSkills || []).map(s => esc(s.skillName)).join(', ') || '—';
  return `<div class="card task-card">
    <h2>Claimed skill verification</h2>
    <p class="faint">CV claims: ${claimed}. NOT TESTED does not mean the candidate does not know it.</p>
    ${rows || '<p class="faint">No skill profile recorded.</p>'}
    <div class="sv-legend">
      <span><i class="lg lg-green"></i>Verified</span>
      <span><i class="lg lg-amber"></i>Partially verified</span>
      <span><i class="lg lg-red"></i>Not verified</span>
      <span><i class="lg lg-gray"></i>Not tested</span>
    </div>
  </div>`;
}

function renderIntegrityCard() {
  const items = detail.integrityIndicators.map(i =>
    `<div class="indicator"><span class="ic">◈</span>${esc(i.detail)}</div>`).join('');
  return `<div class="card task-card">
    <h2>Integrity indicators</h2>
    <p class="faint">Neutral signals only — final judgement is yours. ${items.length ? '' : 'No notable signals.'}</p>
    ${items}
  </div>`;
}

function renderTaskCards() {
  const secMeta = new Map((detail.sections || []).map(sec => [sec.code, sec]));
  let lastSection = null;
  let sectionCount = 0;
  return detail.tasks.map(t => {
    const isFollowup = t.unlockMode === 'admin_reveal';
    const revealed = detail.session.followupRevealedAt != null;

    // slim section header before the first task of each python section
    let sectionHead = '';
    if (detail.session.isPython && t.sectionCode && t.sectionCode !== lastSection) {
      lastSection = t.sectionCode;
      sectionCount += 1;
      const letter = String.fromCharCode(64 + sectionCount); // A, B, C…
      const sec = secMeta.get(t.sectionCode);
      sectionHead = `<div class="section-head">
        <span class="section-letter">${esc(letter)}</span>
        <span class="section-title">Section ${esc(letter)} — ${esc(sec ? sec.label : t.sectionCode)}</span>
        ${sec ? `<span class="section-pts">${esc(sec.maxScore)} pts</span>` : ''}
        <span class="section-rule"></span>
      </div>`;
    }

    let subs = '';
    if (t.type !== 'interviewer_only') {
      subs = t.answers.map(a => {
        let auto = '';
        if (a.autograde) {
          if (a.autograde.available === false) {
            auto = `<span class="badge gray">AUTO: skipped — ${esc(a.autograde.error || 'unavailable')}</span>`;
          } else {
            const passed = a.autograde.tests.filter(x => x.passed).length;
            const totalN = a.autograde.tests.length;
            const allPassed = passed === totalN && totalN > 0;
            const lines = a.autograde.tests.map(x =>
              `<div>· ${esc(x.name)}: ${x.passed ? '✅ PASS' : (x.skipped ? '⚠️ SKIPPED' : '❌ FAIL')} — ${esc(x.detail || '')}</div>`).join('');
            auto = `<div class="autograde ${allPassed ? 'ok' : 'bad'}">
              <span class="badge ${allPassed ? 'green' : 'red'}">AUTO-GRADE ${passed}/${totalN} ${allPassed ? 'PASS' : 'FAIL'}</span>
              <div class="ag-detail">${lines}</div>
            </div>`;
          }
        }
        return `
        <div class="submission">
          <div class="sub-head">
            <span class="sub-ver">v${esc(a.submission_version)}</span>
            <span>${fmtTs(a.submitted_at)}</span>
            <span>time spent: <span class="mono">${fmtClock(a.time_spent_ms / 1000)}</span></span>
          </div>
          ${auto}
          ${a.code ? `<div class="sub-label">Code</div><pre>${esc(a.code)}</pre>` : ''}
          ${a.answer ? `<div class="sub-label">Answer</div><pre>${esc(a.answer)}</pre>` : ''}
          ${a.explanation ? `<div class="sub-label">Explanation</div><pre>${esc(a.explanation)}</pre>` : ''}
        </div>`;
      }).join('') || '<p class="faint">No submission yet.</p>';
      if (t.draft) {
        subs += `<p class="faint">Latest unsaved draft: ${fmtTs(t.draft.updated_at)} · saves: ${t.draft.save_count} · pastes: ${t.draft.paste_events}</p>`;
      }
    }

    const prompt = t.type === 'interviewer_only'
      ? `<div class="question-block">${t.promptHtml}</div>`
      : `<div class="prompt">${t.promptHtml}</div>${t.dataText ? `<div class="data-block">${esc(t.dataText)}</div>` : ''}
         ${t.answerOptions ? `<div class="sub-label">Answer options (correct one is in the answer key)</div><ul class="opt-list">${t.answerOptions.map(o => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}`;

    const heading = detail.session.isPython ? `Q${t.idx + 1}: ` : (t.idx <= 2 ? `Task ${t.idx + 1}: ` : '');

    return `${sectionHead}<div class="card task-card" id="task-${t.id}">
      <div class="task-head">
        <h2>${heading}${esc(t.title)}</h2>
        ${t.skillName ? `<span class="badge blue">${esc(t.skillName)}</span>` : ''}
        ${t.answerOptions ? '<span class="badge gray">MCQ</span>' : ''}
        ${isFollowup ? (revealed
          ? `<span class="badge amber">REVEALED ${fmtTs(detail.session.followupRevealedAt)}</span>`
          : `<button class="small primary" id="btn-reveal">Reveal to candidate</button>`)
          : (t.type === 'interviewer_only' ? '<span class="badge blue">INTERVIEWER ONLY</span>' : `<span class="badge gray">${t.maxScore} pts</span>`)}
      </div>
      ${prompt}
      ${subs}
      ${t.answerKey || t.scoringGuide || t.internalAnswer ? `
      <details class="keydetails">
        <summary>Answer key &amp; scoring guide (admin only)</summary>
        ${t.answerKey ? `<div class="key-box"><div class="klabel">Expected result</div>${esc(t.answerKey)}</div>` : ''}
        ${t.scoringGuide ? `<div class="key-box"><div class="klabel">Scoring guide</div>${esc(t.scoringGuide)}</div>` : ''}
        ${t.internalAnswer ? `<div class="key-box"><div class="klabel">Internal answer</div>${esc(t.internalAnswer)}</div>` : ''}
      </details>` : ''}
    </div>`;
  }).join('');
}

function renderScoresCard() {
  const rows = detail.sections.map(sec => {
    // CSP-safe progress bar: real value/max attributes; color bucket via class
    const ratio = sec.maxScore > 0 && sec.score != null ? sec.score / sec.maxScore : 0;
    const bucket = sec.score != null ? (ratio >= 0.8 ? ' hi' : ratio >= 0.4 ? ' mid' : ' lo') : '';
    return `
    <div class="score-line">
      <span class="lbl">${esc(sec.label)} ${sec.isOverride ? '<span class="badge amber">OVERRIDE</span>' : ''}</span>
      <progress class="score-bar${bucket}" value="${sec.score ?? 0}" max="${esc(sec.maxScore)}"></progress>
      <input type="number" min="0" max="${esc(sec.maxScore)}" value="${sec.score ?? ''}" id="score-${esc(sec.code)}" placeholder="—">
      <span class="max">/ ${esc(sec.maxScore)}</span>
      <button class="small" data-score="${esc(sec.code)}">Save</button>
    </div>`;
  }).join('');
  // recommendation options: Python assessments use their own 5-value scale
  const opts = detail.session.recommendationOptions || [
    { value: 'STRONG_PASS', label: 'STRONG PASS' }, { value: 'PASS', label: 'PASS' },
    { value: 'REVIEW', label: 'REVIEW' }, { value: 'FAIL', label: 'FAIL' }
  ];
  return `<div class="card task-card">
    <h2>Scoring</h2>
    ${rows}
    <div class="total-line">
      <span class="muted">Total</span>
      <span class="v">${detail.totalScore != null ? `${detail.totalScore} / ${detail.maxTotal}` : '— / ' + detail.maxTotal}</span>
    </div>
    ${detail.session.isPython && detail.session.scoreLevel ? `<div class="total-line tight">
      <span class="muted">Score level</span><span class="badge ${detail.session.scoreLevel.cls}">${esc(detail.session.scoreLevel.label.toUpperCase())}</span>
    </div>` : ''}
    <div class="total-line tight">
      <span class="muted">Auto recommendation</span>${recBadge(detail.session.autoRecommendation)}
    </div>
    <label>Final recommendation (manual override)</label>
    <select id="final-rec">
      <option value="">— auto (use score thresholds) —</option>
      ${opts.map(o => `<option value="${o.value}" ${detail.session.finalRecommendation === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>
    <div class="finalize-row">
      <button class="primary" id="btn-finalize">Finalize assessment</button>
    </div>
    <p class="faint mt-8">Finalizing locks the recommendation and marks the session REVIEWED.</p>
  </div>`;
}

function renderNotesCard() {
  const notes = detail.notes.map(n => `
    <div class="note-item">
      <div>${esc(n.note)}</div>
      <div class="when">${esc(n.author)} · ${fmtTs(n.created_at)}</div>
    </div>`).join('');
  return `<div class="card task-card">
    <h2>Interviewer notes</h2>
    ${notes || '<p class="faint">No notes yet.</p>'}
    <textarea id="note-input" placeholder="Observations, verbal answers, judgement…"></textarea>
    <div class="mt-8"><button class="small" id="btn-note">Add note</button></div>
  </div>`;
}

const EVENT_DOT_CLS = {
  SCORE_SET: 'dot-green', SCORE_UPDATED: 'dot-green',
  ANSWER_SAVED: 'dot-blue', ANSWER_SUBMITTED: 'dot-blue',
  ALL_CODE_TASKS_SUBMITTED: 'dot-blue', CODE_RUN: 'dot-blue',
  FOLLOWUP_REVEALED: 'dot-amber', TASK_UNLOCKED: 'dot-amber', PASTE_DETECTED: 'dot-amber',
  TIME_EXPIRED: 'dot-red'
};

function renderTimelineCard() {
  const rows = detail.events.slice(-40).reverse().map(ev => {
    const dot = EVENT_DOT_CLS[ev.event_type] || '';
    const extra = ev.task_id != null ? `<span class="tl-extra">task ${esc(ev.task_id)}</span>` : '';
    return `
    <div class="tl-row"><span class="tl-dot ${dot}"></span><span class="tl-time">${fmtTs(ev.created_at)}</span><span class="tl-type">${esc(ev.event_type)}</span>${extra}</div>`;
  }).join('');
  return `<div class="card task-card">
    <h2>Event timeline</h2>
    <div class="timeline">${rows || '<p class="faint">No events.</p>'}</div>
  </div>`;
}

function bindDetailActions() {
  const s = detail.session;

  const revealBtn = document.getElementById('btn-reveal');
  if (revealBtn) revealBtn.onclick = async () => {
    const ok = await confirmModal({
      title: 'Reveal hidden follow-up scenario?',
      body: 'The candidate screen will immediately show the IP Rotation scenario and its answer box.',
      confirmText: 'Reveal'
    });
    if (!ok) return;
    try {
      await api(`/api/admin/assessments/${s.id}/unlock-task`, { method: 'POST', body: { action: 'reveal_followup' } });
      toast('Follow-up revealed to candidate');
      await loadDetail(s.id);
    } catch (e) { toast(e.message, true); }
  };

  document.querySelectorAll('[data-score]').forEach(btn => {
    btn.onclick = async () => {
      const code = btn.dataset.score;
      const val = document.getElementById(`score-${code}`).value;
      try {
        await api(`/api/admin/assessments/${s.id}/score`, { method: 'POST', body: { sectionCode: code, score: Number(val) } });
        toast('Score saved');
        await loadDetail(s.id);
      } catch (e) { toast(e.data && e.data.error === 'INVALID_SCORE' ? `Score must be 0–${e.data.max}` : e.message, true); }
    };
  });

  const noteBtn = document.getElementById('btn-note');
  if (noteBtn) noteBtn.onclick = async () => {
    const note = document.getElementById('note-input').value.trim();
    if (!note) return;
    try {
      await api(`/api/admin/assessments/${s.id}/notes`, { method: 'POST', body: { note } });
      toast('Note added');
      await loadDetail(s.id);
    } catch (e) { toast(e.message, true); }
  };

  const finBtn = document.getElementById('btn-finalize');
  if (finBtn) finBtn.onclick = async () => {
    const rec = document.getElementById('final-rec').value || null;
    const ok = await confirmModal({
      title: 'Finalize assessment?',
      body: rec ? `Recommendation will be set to ${rec}.` : 'Recommendation will use the automatic score thresholds.',
      confirmText: 'Finalize'
    });
    if (!ok) return;
    try {
      await api(`/api/admin/assessments/${s.id}/finalize`, { method: 'POST', body: { recommendation: rec } });
      toast('Assessment finalized');
      await loadDetail(s.id);
      await loadCandidates();
    } catch (e) { toast(e.message, true); }
  };

  const repBtn = document.getElementById('btn-report');
  if (repBtn) repBtn.onclick = () => openReport(s.id);
}

// ---------- report ----------
const REPORT_REC_LABELS = {
  STRONG_PASS: 'STRONG PASS', PASS: 'PASS', REVIEW: 'REVIEW', FAIL: 'FAIL',
  STRONG_FIT: 'STRONG FIT', SUITABLE: 'SUITABLE',
  SUITABLE_WITH_SUPERVISION: 'SUITABLE WITH SUPERVISION',
  FURTHER_INTERVIEW: 'FURTHER INTERVIEW', NOT_RECOMMENDED: 'NOT RECOMMENDED'
};
const REPORT_SKILL_LABELS = {
  VERIFIED: 'VERIFIED', PARTIALLY_VERIFIED: 'PARTIALLY VERIFIED',
  NOT_VERIFIED: 'NOT VERIFIED', NOT_TESTED: 'NOT TESTED'
};

async function openReport(sessionId) {
  try {
    const r = await api(`/api/admin/assessments/${sessionId}/report`);
    const rows = r.sections.map(sec => `
      <tr><td>${esc(sec.label)}</td><td class="mono">${sec.score ?? '—'} / ${sec.maxScore}${sec.isOverride ? ' (override)' : ''}</td></tr>`).join('');
    const tasks = r.taskResults.map(t => `
      <tr><td>${esc(t.title)}</td><td class="mono">${t.submittedVersions} submission(s)</td>
      <td class="mono">${t.timeSpentMs != null ? fmtClock(t.timeSpentMs / 1000) : '—'}</td></tr>`).join('');
    const inds = r.integrityIndicators.map(i => `<li>${esc(i.detail)}</li>`).join('') || '<li>None recorded.</li>';
    const notes = r.notes.map(n => `<li>${esc(n.note)}</li>`).join('') || '<li>—</li>';
    const skillSection = r.skillResults ? `
      <h2>Claimed skill verification</h2>
      <table><tr><th>Claimed skill</th><th>Claimed level</th><th>Status</th><th>Evidence</th></tr>
      ${r.skillResults.map(s => `
        <tr><td>${esc(s.skillName)}</td>
        <td>${esc(s.claimedLevel || '—')}</td>
        <td><span class="rpt-status ${SKILL_STATUS_CLS[s.status] || 'gray'}">${esc(REPORT_SKILL_LABELS[s.status] || s.status)}</span>${s.maxScore != null ? ` <span class="mono">(${s.score ?? '—'} / ${s.maxScore})</span>` : ''}</td>
        <td>${esc(s.notes || '')}</td></tr>`).join('')}
      </table>
      <p class="note-text">NOT TESTED does not mean the candidate does not know a technology — it was simply not assessed.</p>` : '';
    document.getElementById('rep-body').innerHTML = `
      <div class="report">
        <div class="report-head">
          <div class="report-brand">Intern Assessment Platform</div>
          <h1>${r.isPython ? 'Python Technical Assessment Report' : 'Intern Assessment Report'}</h1>
          <div class="report-sub">${esc(r.candidate)} — ${esc(r.assessment)}</div>
        </div>
        <div class="report-body">
          <table>
            <tr><th>Candidate</th><td>${esc(r.candidate)}</td></tr>
            <tr><th>Assessment</th><td>${esc(r.assessment)}</td></tr>
            <tr><th>Status</th><td>${esc(r.status)}</td></tr>
            <tr><th>Time used</th><td class="mono">${r.durationUsedMs != null ? fmtClock(r.durationUsedMs / 1000) + ' / ' + fmtClock(r.durationLimitSeconds) : '—'}</td></tr>
            <tr><th>Total score</th><td class="mono"><b>${r.totalScore ?? 'PENDING'} / ${r.maxTotal}</b>${r.scoreLevel ? ` — level: <b>${esc(r.scoreLevel.label)}</b>` : ''}</td></tr>
            <tr class="rpt-rec-row"><th>Recommendation</th><td><b>${esc(REPORT_REC_LABELS[r.finalRecommendation] || (r.finalRecommendation || 'PENDING'))}</b>${r.finalRecommendation !== r.autoRecommendation ? ` (auto: ${esc(REPORT_REC_LABELS[r.autoRecommendation] || r.autoRecommendation || '—')})` : ''}</td></tr>
          </table>
          <h2>Score breakdown</h2>
          <table>${rows}</table>
          ${skillSection}
          <h2>Task results</h2>
          <table><tr><th>Task</th><th>Submissions</th><th>Time spent</th></tr>${tasks}</table>
          <h2>Integrity indicators</h2><ul>${inds}</ul>
          <h2>Interviewer notes</h2><ul>${notes}</ul>
          <div class="report-foot mono">Generated ${new Date().toLocaleString()} · Intern Assessment Platform</div>
        </div>
      </div>`;
    document.getElementById('rep-back').classList.add('open');
  } catch (e) { toast('Failed to generate report', true); }
}

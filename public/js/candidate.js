'use strict';

// Candidate screen. The ONLY data source is GET /api/candidate/assessment/current;
// the server never includes answer keys, scoring rules or hidden tasks in it.

const state = {
  view: null,          // last rendered server state
  viewKey: null,
  skew: 0,             // serverNow - localNow at last fetch
  dirty: false,
  timerInterval: null,
  pollInterval: null
};

const $main = document.getElementById('main');
const $timer = document.getElementById('timer');
const $progress = document.getElementById('progress');

// ---------- bootstrap ----------
(async function init() {
  try {
    const me = await api('/api/auth/me');
    if (me.role !== 'candidate') { location.href = me.role === 'admin' ? '/admin' : '/'; return; }
  } catch { location.href = '/'; return; }

  document.getElementById('logout').onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.href = '/';
  };

  await refresh(true);
  state.pollInterval = setInterval(() => refresh(false), 4000);
  setInterval(autoSave, 20000);
  window.addEventListener('visibilitychange', () => { if (document.hidden) autoSave(); });
})();

async function refresh(showErrors) {
  try {
    const v = await api('/api/candidate/assessment/current');
    state.skew = v.timer.serverNow - Date.now();
    const key = JSON.stringify([v.state, v.status, v.task ? v.task.id : null,
      v.task ? v.task.submittedVersions.length : null, v.followupRevealed]);
    if (key !== state.viewKey) {
      state.viewKey = key;
      state.view = v;
      render(v);
    }
    updateProgress(v);
  } catch (e) {
    if (e.status === 401) { location.href = '/'; return; }
    if (showErrors) toast('Failed to load assessment', true);
  }
}

// ---------- progress + timer ----------
function updateProgress(v) {
  if (v.progress && v.progress.length) {
    const label = v.naming === 'question' ? 'Q' : 'Task';
    $progress.hidden = false;
    $progress.innerHTML = v.progress.map(p => {
      const cls = p.submitted ? 'done' : (v.task && p.id === v.task.id ? 'active' : '');
      return `<span class="progress-step ${cls}">${label} ${p.idx + 1}${p.submitted ? ' ✓' : ''}</span>`;
    }).join('');
  } else {
    $progress.hidden = true;
  }
}

function tickTimer() {
  const v = state.view;
  if (!v || !v.timer || v.timer.deadlineAt == null) { $timer.hidden = true; return; }
  $timer.hidden = false;
  const remaining = Math.max(0, Math.ceil((v.timer.deadlineAt - (Date.now() + state.skew)) / 1000));
  $timer.textContent = fmtClock(remaining);
  $timer.classList.toggle('warn', remaining <= 300 && remaining > 60);
  $timer.classList.toggle('crit', remaining <= 60);
}

setInterval(tickTimer, 250);

// ---------- rendering ----------
function render(v) {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  state.dirty = false;
  // the header brand reflects the assigned assessment (e.g. Python vs Cybersecurity)
  if (v.assessmentTitle) {
    document.querySelector('.topbar .brand').innerHTML =
      `<span class="brand-mark">⌘</span> <span class="brand-text">${esc(v.assessmentTitle)}</span>`;
    document.title = `${v.assessmentTitle} — Candidate`;
  }

  switch (v.state) {
    case 'NOT_STARTED': return renderNotStarted(v);
    case 'TASK': return renderTask(v);
    case 'WAITING_INTERVIEWER': return renderWaiting(v);
    case 'READY_TO_FINISH': return renderReadyToFinish(v);
    case 'TIME_EXPIRED': return renderExpired(v);
    case 'COMPLETED': return renderCompleted(v);
    default: return renderNoSession(v);
  }
  tickTimer();
}

function renderNoSession(v) {
  $main.innerHTML = `<div class="card center-note">
    <div class="icon tint-faint">○</div>
    <p class="muted">No assessment has been assigned to your account yet.</p>
    <p class="faint">Please wait — your interviewer will set it up.</p>
  </div>`;
}

function renderNotStarted(v) {
  const items = (v.instructions && v.instructions.intro || [])
    .map(i => `<li>${esc(i)}</li>`).join('');
  const minutes = v.durationSeconds ? Math.round(v.durationSeconds / 60) : 30;
  $main.innerHTML = `
    <div class="card cover-card">
      <div class="cover-kicker">Candidate assessment</div>
      <h1 class="cover-title">${esc(v.assessmentTitle)}</h1>
      <p class="muted cover-sub">Welcome, ${esc(v.candidateName)}. Read the instructions below, then press Start — the timer begins immediately.</p>
      <div class="cover-meta">
        <span class="meta-chip"><span class="meta-ic">⏱</span>${minutes} min</span>
      </div>
      <div class="banner blue cover-banner">The assessment is <b>timed end-to-end</b>. Once started, the countdown cannot be paused.</div>
      ${items ? `
      <h3 class="cover-heading">Instructions</h3>
      <ul class="instr-list">${items}</ul>` : ''}
      <div class="cover-actions">
        <button class="primary big-btn" id="start-btn">Start Assessment</button>
        <span class="faint">Duration: ${fmtClock(v.durationSeconds || 1800)}</span>
      </div>
    </div>`;
  document.getElementById('start-btn').onclick = async () => {
    const ok = await confirmModal({
      title: 'Start the assessment?',
      body: `The ${minutes}-minute timer starts immediately and cannot be paused.`,
      confirmText: 'Start Assessment'
    });
    if (!ok) return;
    try {
      const nv = await api('/api/candidate/assessment/start', { method: 'POST' });
      state.skew = nv.timer.serverNow - Date.now();
      state.view = nv;
      state.viewKey = null;
      render(nv);
      updateProgress(nv);
    } catch (e) { handleErr(e); }
  };
}

function renderTask(v) {
  const t = v.task;
  const codeVal = t.draft ? t.draft.code : (t.starterCode || '');
  const ansVal = t.draft ? t.draft.answer : '';
  const explVal = t.draft ? t.draft.explanation : '';
  const unit = v.naming === 'question' ? 'Question' : 'Task';
  const counter = v.taskCount ? `<span class="badge blue">${unit} ${t.idx + 1} of ${v.taskCount}</span>` : '';

  // Multiple choice: radios replace the free-text answer box; the selected
  // option text is stored in the same `answer` field server-side.
  const mcqHtml = t.answerOptions ? `
    <div class="mcq-list" id="mcq-list" role="radiogroup">
      ${t.answerOptions.map(opt => `
        <label class="mcq-option">
          <input type="radio" name="mcq-option" value="${esc(opt)}" ${ansVal === opt ? 'checked' : ''}>
          <span>${esc(opt)}</span>
        </label>`).join('')}
    </div>` : '';

  const editorHtml = t.answerOptions ? '' : (t.codeEditor ? `
    <div class="editor-shell">
      <div class="editor-chrome" aria-hidden="true"><span class="chrome-dot"></span><span class="chrome-dot"></span><span class="chrome-dot"></span><span class="chrome-title">main.py</span></div>
      <div class="editor-wrap" id="editor-wrap">
        <pre class="editor-highlight" id="editor-hl"></pre>
        <textarea class="editor-input" id="code" spellcheck="false" autocomplete="off"
          autocapitalize="off" autocorrect="off" wrap="off">${esc(codeVal)}</textarea>
      </div>
    </div>
    <div class="editor-toolbar">
      <button class="small" id="btn-run">Run</button>
      <button class="small" id="btn-clear">Clear</button>
      <span class="spacer"></span>
      <span class="faint">Python</span>
    </div>
    <pre class="run-output" id="run-output" hidden></pre>` : '');

  $main.innerHTML = `
    <div class="card task-card">
      <div class="task-head">
        <div class="task-title-row">
          <h1>${esc(t.title)}</h1>
          <div class="task-badges">${counter}${t.followUp
            ? '<span class="badge amber">Follow-up</span>'
            : (t.answerOptions ? '<span class="badge blue">Multiple choice</span>' : '')}</div>
        </div>
      </div>
      <div class="prompt">${t.promptHtml}</div>
      ${t.dataText ? `<div class="data-block">${esc(t.dataText)}</div>` : ''}
      ${editorHtml}
      ${mcqHtml}
      ${!t.answerOptions ? `<label for="answer">${t.codeEditor ? 'Answer / notes for the interviewer' : 'Your answer'}</label>
      <textarea class="answer-area" id="answer" placeholder="${t.codeEditor ? 'Optional — describe your approach or result' : 'Type your answer here…'}">${esc(ansVal)}</textarea>` : ''}
      <label for="explanation">Why does your solution work? ${t.explanationRequired ? '<span class="req-mark" title="Required">*</span>' : '<span class="faint">(optional)</span>'}</label>
      <textarea id="explanation" placeholder="Explain your reasoning in your own words…">${esc(explVal)}</textarea>
      ${v.task.submittedVersions.length ? `<p class="faint">Submitted ${v.task.submittedVersions.length} time(s) so far. Latest at ${fmtTs(v.task.submittedVersions[v.task.submittedVersions.length - 1].submitted_at)}.</p>` : ''}
      <div class="action-bar">
        <span class="save-state" id="save-state"></span>
        <span class="spacer"></span>
        <button class="quiet" id="btn-save">Save</button>
        <button class="primary" id="btn-submit">Submit Task</button>
      </div>
    </div>`;

  if (t.answerOptions) {
    document.querySelectorAll('input[name="mcq-option"]').forEach(radio => {
      radio.addEventListener('change', () => { state.dirty = true; });
    });
  }

  if (!t.answerOptions && t.codeEditor) {
    const $code = document.getElementById('code');
    const $hl = document.getElementById('editor-hl');
    const syncHl = () => { $hl.innerHTML = highlightPython($code.value) + '\n'; };
    $code.addEventListener('input', () => { state.dirty = true; syncHl(); });
    $code.addEventListener('scroll', () => { $hl.scrollTop = $code.scrollTop; $hl.scrollLeft = $code.scrollLeft; });
    $code.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = $code.selectionStart, en = $code.selectionEnd;
        $code.value = $code.value.slice(0, s) + '    ' + $code.value.slice(en);
        $code.selectionStart = $code.selectionEnd = s + 4;
        state.dirty = true; syncHl();
      }
    });
    $code.addEventListener('focus', () => document.getElementById('editor-wrap').classList.add('focused'));
    $code.addEventListener('blur', () => document.getElementById('editor-wrap').classList.remove('focused'));
    $code.addEventListener('paste', e => reportPaste(e));
    syncHl();
    document.getElementById('btn-run').onclick = async () => {
      const btn = document.getElementById('btn-run');
      const out = document.getElementById('run-output');
      if (!$code.value.trim()) { toast('Write some code first', true); return; }
      btn.disabled = true; btn.textContent = 'Running…';
      out.hidden = false;
      out.textContent = 'Running…';
      try {
        const r = await api('/api/candidate/run', { method: 'POST', body: { code: $code.value } });
        let text = '';
        if (r.stdout) text += r.stdout + (r.stdout.endsWith('\n') ? '' : '\n');
        if (r.stderr) text += '[stderr]\n' + r.stderr + '\n';
        if (!r.stdout && !r.stderr) text = '(no output)\n';
        text += r.timedOut
          ? '✖ Timed out after 4s (infinite loop?)'
          : `✔ Finished in ${r.ranMs} ms` + (r.exitCode !== 0 ? ` — exit code ${r.exitCode}` : '');
        out.textContent = text;
        out.classList.toggle('err', r.timedOut || r.exitCode !== 0);
      } catch (e) {
        out.textContent = e.status === 429 ? '⏳ Too many runs — wait a minute (limit: 12 per minute).' : '✖ ' + (e.message || 'Run failed');
        out.classList.add('err');
      } finally {
        btn.disabled = false; btn.textContent = 'Run';
      }
    };
    document.getElementById('btn-clear').onclick = async () => {
      const ok = await confirmModal({ title: 'Clear the editor?', body: 'This clears the code editor (not saved drafts).', confirmText: 'Clear', danger: true });
      if (ok) { $code.value = ''; syncHl(); state.dirty = true; }
    };
  }

  const $answer = document.getElementById('answer');
  const $expl = document.getElementById('explanation');
  [$answer, $expl].forEach(el => {
    if (!el) return;
    el.addEventListener('input', () => { state.dirty = true; });
    el.addEventListener('paste', e => reportPaste(e));
  });

  document.getElementById('btn-save').onclick = () => saveDraft(true);
  document.getElementById('btn-submit').onclick = submitTask;
}

async function reportPaste(e) {
  try {
    const text = (e.clipboardData || window.clipboardData).getData('text') || '';
    await api('/api/candidate/events', { method: 'POST', body: { type: 'paste', chars: text.length } });
  } catch { /* telemetry is best-effort */ }
}

function renderWaiting(v) {
  $main.innerHTML = `
    <div class="card center-note">
      <div class="icon tint-amber">⏳</div>
      <h1>All visible tasks submitted</h1>
      <p class="muted">Your interviewer will continue with the next stage of the assessment.</p>
      <p class="faint">Keep this window open — the next part will appear here automatically.</p>
      <div class="stat-row center-stats">
        <div class="stat"><div class="k">Timer</div><div class="v" id="wait-timer">--:--</div></div>
      </div>
    </div>`;
}

function renderReadyToFinish(v) {
  $main.innerHTML = `
    <div class="card center-note">
      <div class="icon tint-green">✅</div>
      <h1>Follow-up submitted</h1>
      <p class="muted">You have completed all parts of this assessment that are done on your side.</p>
      <button class="success big-btn" id="finish-btn">Submit Final Assessment</button>
    </div>`;
  document.getElementById('finish-btn').onclick = async () => {
    const ok = await confirmModal({
      title: 'Submit final assessment?',
      body: 'This ends your assessment session. You cannot go back afterwards.',
      confirmText: 'Submit Final Assessment'
    });
    if (!ok) return;
    try {
      await api('/api/candidate/assessment/complete', { method: 'POST' });
      state.viewKey = null;
      await refresh(false);
    } catch (e) { handleErr(e); }
  };
}

function renderExpired(v) {
  const done = (v.progress || []).filter(p => p.submitted).length;
  const total = (v.progress || []).length;
  $main.innerHTML = `
    <div class="banner red expiry-banner">⏱ <span><b>Time is up.</b> You can no longer submit answers. Everything you saved has been preserved for the interviewer.</span></div>
    <div class="card center-note">
      <div class="icon tint-red">⏱</div>
      <h1>Assessment time expired</h1>
      <p class="muted">Submitted ${done} of ${total} tasks before the deadline.</p>
      <p class="faint">Please hand over to your interviewer.</p>
    </div>`;
}

function renderCompleted(v) {
  $main.innerHTML = `
    <div class="card center-note">
      <div class="icon tint-green">🎉</div>
      <h1>Assessment submitted</h1>
      <p class="muted">Thank you, ${esc(v.candidateName)}. Your submission is complete.</p>
      <p class="faint">The interviewer will take it from here. You may close this window.</p>
    </div>`;
}

// ---------- actions ----------
function currentPayload() {
  const t = state.view && state.view.task;
  if (!t) return null;
  let answer = document.getElementById('answer')?.value ?? '';
  if (t.answerOptions) {
    // MCQ: the checked option text travels in the same `answer` field
    const sel = document.querySelector('input[name="mcq-option"]:checked');
    answer = sel ? sel.value : '';
  }
  return {
    code: t.codeEditor && !t.answerOptions ? (document.getElementById('code')?.value ?? '') : '',
    answer,
    explanation: document.getElementById('explanation')?.value ?? ''
  };
}

async function saveDraft(loud) {
  const t = state.view && state.view.task;
  if (!t) return;
  const payload = currentPayload();
  try {
    const r = await api(`/api/candidate/tasks/${t.id}/save`, { method: 'POST', body: payload });
    state.dirty = false;
    if (loud) toast('Saved');
    const el = document.getElementById('save-state');
    if (el) el.textContent = `Saved ${fmtTs(r.savedAt)}`;
  } catch (e) { handleErr(e, loud); }
}

async function autoSave() {
  if (state.dirty && state.view && state.view.state === 'TASK') await saveDraft(false);
}

async function submitTask() {
  const t = state.view && state.view.task;
  if (!t) return;
  if (state.dirty) await saveDraft(false);
  const ok = await confirmModal({
    title: `Submit ${t.title}?`,
    body: 'After submitting you move to the next stage and cannot edit this task again.',
    confirmText: 'Submit Task'
  });
  if (!ok) return;
  const payload = currentPayload();
  try {
    const r = await api(`/api/candidate/tasks/${t.id}/submit`, { method: 'POST', body: payload });
    toast(r.nextUnlocked ? 'Submitted — next task unlocked' : 'Submitted');
    state.viewKey = null;
    await refresh(false);
  } catch (e) { handleErr(e, true); }
}

function handleErr(e, loud = true) {
  if (e.status === 401) { location.href = '/'; return; }
  const map = {
    TIME_EXPIRED: 'Time is up — submission rejected.',
    TASK_NOT_UNLOCKED: 'That task is locked.',
    EXPLANATION_REQUIRED: 'The explanation field is required for this task.',
    SESSION_NOT_ACTIVE: 'The session is no longer active.',
    RATE_LIMITED: 'Too many requests — slow down.'
  };
  if (loud) toast(map[e.status && e.message] || map[e.message] || e.message || 'Request failed', true);
  if (['TIME_EXPIRED', 'TASK_NOT_UNLOCKED', 'SESSION_NOT_ACTIVE'].includes(e.message)) {
    state.viewKey = null;
    refresh(false);
  }
}

// ---------- python syntax highlighting (overlay) ----------
const PY_TOKEN = /(&quot;[\s\S]*?&quot;|&#39;[\s\S]*?&#39;)|(#[^\n]*)|(\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)(?=\()/g;

function highlightPython(src) {
  // single pass — sequential regexes would corrupt nested replacements
  return esc(src).replace(PY_TOKEN, (m, str, com, kw, num, fn) => {
    if (str) return `<span class="tok-str">${str}</span>`;
    if (com) return `<span class="tok-com">${com}</span>`;
    if (kw) return `<span class="tok-kw">${kw}</span>`;
    if (num) return `<span class="tok-num">${num}</span>`;
    return `<span class="tok-fn">${fn}</span>`;
  });
}

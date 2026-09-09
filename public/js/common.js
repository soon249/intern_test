'use strict';

// Shared helpers. All dynamic strings rendered into HTML must go through esc().

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch'
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP_${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fmtClock(totalSeconds) {
  if (totalSeconds == null) return '--:--';
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtTs(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const STATUS_LABELS = {
  NOT_STARTED: ['NOT STARTED', 'gray'],
  IN_PROGRESS: ['IN PROGRESS', 'blue'],
  SUBMITTED: ['SUBMITTED', 'amber'],
  COMPLETED: ['COMPLETED', 'green'],
  TIME_EXPIRED: ['TIME EXPIRED', 'red'],
  REVIEWED: ['REVIEWED', 'green']
};

const REC_LABELS = {
  STRONG_PASS: ['STRONG PASS', 'green'],
  PASS: ['PASS', 'green'],
  REVIEW: ['REVIEW', 'amber'],
  FAIL: ['FAIL', 'red'],
  // Python assessment recommendation set
  STRONG_FIT: ['STRONG FIT', 'green'],
  SUITABLE: ['SUITABLE', 'green'],
  SUITABLE_WITH_SUPERVISION: ['SUITABLE W/ SUPERVISION', 'amber'],
  FURTHER_INTERVIEW: ['FURTHER INTERVIEW', 'amber'],
  NOT_RECOMMENDED: ['NOT RECOMMENDED', 'red']
};

function statusBadge(status) {
  const [label, cls] = STATUS_LABELS[status] || [status, 'gray'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function recBadge(rec) {
  if (!rec) return '<span class="badge gray">—</span>';
  const [label, cls] = REC_LABELS[rec] || [rec, 'gray'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function confirmModal({ title, body, confirmText = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const back = document.getElementById('modal-back');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').textContent = body;
    const ok = document.getElementById('modal-ok');
    const cancel = document.getElementById('modal-cancel');
    ok.textContent = confirmText;
    ok.className = danger ? 'danger' : 'primary';
    back.classList.add('open');
    const done = val => {
      back.classList.remove('open');
      ok.onclick = cancel.onclick = back.onclick = null;
      resolve(val);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    back.onclick = e => { if (e.target === back) done(false); };
  });
}

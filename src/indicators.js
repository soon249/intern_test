import { db, now } from './db.js';

/**
 * "Assessment Integrity Indicators" — neutral signals with evidence.
 * The final judgement always belongs to the interviewer; nothing here
 * labels a candidate as cheating.
 */
export function computeIndicators(session) {
  const out = [];
  if (!session || !session.started_at) return out;

  const tasks = db.prepare(
    `SELECT t.id, t.idx, t.title FROM assessment_tasks t
      WHERE t.assessment_id = ? AND t.unlock_mode IN ('after_previous','admin_reveal') ORDER BY t.idx`
  ).all(session.assessment_id);

  const durationMs = Math.max(1, session.deadline_at - session.started_at);

  for (const task of tasks) {
    const versions = db.prepare(
      `SELECT submission_version, submitted_at, time_spent_ms, LENGTH(answer) AS answer_len, LENGTH(code) AS code_len, explanation
         FROM assessment_answers WHERE session_id = ? AND task_id = ? ORDER BY submission_version`
    ).all(session.id, task.id);
    if (versions.length === 0) continue;

    const draft = db.prepare(
      'SELECT save_count, paste_events, max_paste_chars FROM assessment_drafts WHERE session_id = ? AND task_id = ?'
    ).get(session.id, task.id);

    const last = versions[versions.length - 1];
    const taskMin = Math.round((last.time_spent_ms || 0) / 60000);

    if (versions.length >= 2) {
      out.push({
        code: 'MANY_REVISIONS',
        severity: 'info',
        detail: `Task ${task.idx + 1} (${task.title}) was submitted ${versions.length} times (answer revisions).`
      });
    }
    if (draft && draft.save_count <= 1 && last.code_len + last.answer_len >= 400) {
      out.push({
        code: 'NO_INTERMEDIATE_EDITS',
        severity: 'info',
        detail: `Task ${task.idx + 1} was submitted with ${draft.save_count} save(s) despite a large answer (${last.code_len + last.answer_len} chars) — little evidence of incremental work.`
      });
    }
    if (last.time_spent_ms > 0 && last.time_spent_ms < 60000 && (last.code_len + last.answer_len) >= 500) {
      out.push({
        code: 'UNUSUALLY_FAST',
        severity: 'info',
        detail: `Task ${task.idx + 1} submitted in under a minute (${taskMin} min) with ${last.code_len + last.answer_len} characters of content.`
      });
    }
    if (draft && draft.max_paste_chars >= 300) {
      out.push({
        code: 'LARGE_PASTE',
        severity: 'info',
        detail: `A paste of ~${draft.max_paste_chars} characters was detected while working on Task ${task.idx + 1}.`
      });
    }
  }

  const pastes = db.prepare(
    `SELECT payload, created_at FROM assessment_events
      WHERE session_id = ? AND event_type = 'PASTE_DETECTED' ORDER BY created_at`
  ).all(session.id);
  let maxPaste = 0;
  for (const p of pastes) {
    try { maxPaste = Math.max(maxPaste, JSON.parse(p.payload || '{}').chars || 0); } catch { /* ignore */ }
  }
  if (maxPaste >= 300) {
    out.push({
      code: 'LARGE_PASTE_EVENTS',
      severity: 'info',
      detail: `${pastes.length} paste event(s) reported by the candidate's browser, largest ~${maxPaste} characters.`
    });
  }

  // overall time usage
  const end = session.final_submitted_at || Math.min(now(), session.deadline_at);
  const usedMs = Math.max(0, end - session.started_at);
  const usedMin = Math.floor(usedMs / 60000);
  const usedSec = Math.floor((usedMs % 60000) / 1000);
  out.push({
    code: 'TIME_USAGE',
    severity: 'info',
    detail: `Used ${usedMin}:${String(usedSec).padStart(2, '0')} of the ${Math.round(durationMs / 60000)} minutes (${Math.round((usedMs / durationMs) * 100)}% of allotted time).`
  });

  const expiredEarly = session.status === 'TIME_EXPIRED';
  if (expiredEarly) {
    out.push({ code: 'TIMER_EXPIRED', severity: 'info', detail: 'Timer expired before the candidate finished; partial work preserved.' });
  }

  return out;
}

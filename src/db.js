import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'assessment.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','candidate')),
  display_name TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  position TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assessment_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('code','scenario','interviewer_only')),
  prompt_html TEXT NOT NULL,
  data_text TEXT,
  starter_code TEXT,
  explanation_required INTEGER NOT NULL DEFAULT 0,
  code_editor INTEGER NOT NULL DEFAULT 1,
  answer_key TEXT,
  scoring_guide TEXT,
  internal_answer TEXT,
  unlock_mode TEXT NOT NULL DEFAULT 'after_previous' CHECK (unlock_mode IN ('after_previous','admin_reveal','never_candidate')),
  max_score INTEGER NOT NULL DEFAULT 0,
  UNIQUE (assessment_id, idx)
);

CREATE TABLE IF NOT EXISTS assessment_score_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  max_score INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  UNIQUE (assessment_id, code)
);

CREATE TABLE IF NOT EXISTS assessment_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id),
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (status IN ('NOT_STARTED','IN_PROGRESS','SUBMITTED','COMPLETED','TIME_EXPIRED','REVIEWED')),
  started_at INTEGER,
  deadline_at INTEGER,
  completed_at INTEGER,
  final_submitted_at INTEGER,
  reviewed_at INTEGER,
  followup_revealed_at INTEGER,
  followup_revealed_by INTEGER,
  final_recommendation TEXT CHECK (final_recommendation IN ('STRONG_PASS','PASS','REVIEW','FAIL')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assessment_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES assessment_tasks(id) ON DELETE CASCADE,
  code TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  save_count INTEGER NOT NULL DEFAULT 0,
  paste_events INTEGER NOT NULL DEFAULT 0,
  max_paste_chars INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, task_id)
);

CREATE TABLE IF NOT EXISTS assessment_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES assessment_tasks(id),
  answer TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  submitted_at INTEGER NOT NULL,
  time_spent_ms INTEGER NOT NULL,
  submission_version INTEGER NOT NULL,
  UNIQUE (session_id, task_id, submission_version)
);

CREATE TABLE IF NOT EXISTS assessment_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  section_code TEXT NOT NULL,
  max_score INTEGER NOT NULL,
  score INTEGER,
  is_override INTEGER NOT NULL DEFAULT 0,
  update_count INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER,
  UNIQUE (session_id, section_code)
);

CREATE TABLE IF NOT EXISTS interviewer_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  section_code TEXT,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assessment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  candidate_id INTEGER,
  actor_id INTEGER,
  event_type TEXT NOT NULL,
  task_id INTEGER,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON assessment_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_answers_session ON assessment_answers(session_id, task_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS candidate_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  claimed_level TEXT NOT NULL DEFAULT 'intermediate'
    CHECK (claimed_level IN ('beginner','intermediate','advanced','expert')),
  source TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  UNIQUE (candidate_id, skill_name)
);

CREATE TABLE IF NOT EXISTS question_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'intermediate' CHECK (difficulty IN ('baseline','foundation','intermediate')),
  qtype TEXT NOT NULL CHECK (qtype IN ('mcq','code','scenario','explanation')),
  title TEXT NOT NULL,
  prompt_html TEXT NOT NULL,
  data_text TEXT,
  starter_code TEXT,
  answer_options TEXT,
  answer_key TEXT,
  scoring_guide TEXT,
  internal_answer TEXT,
  explanation_required INTEGER NOT NULL DEFAULT 0,
  code_editor INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 5,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  followup_of TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assessment_skill_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  weight INTEGER NOT NULL,
  UNIQUE (assessment_id, skill_name)
);

CREATE TABLE IF NOT EXISTS assessment_skill_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  claimed_level TEXT,
  score INTEGER,
  max_score INTEGER,
  verification_status TEXT NOT NULL DEFAULT 'NOT_TESTED'
    CHECK (verification_status IN ('VERIFIED','PARTIALLY_VERIFIED','NOT_VERIFIED','NOT_TESTED')),
  notes TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_candidate_skills ON candidate_skills(candidate_id);
CREATE INDEX IF NOT EXISTS idx_question_bank_cat ON question_bank(category, is_active);
`);

// ---- additive migrations for pre-existing databases ----
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

addColumnIfMissing('assessment_tasks', 'answer_options', 'answer_options TEXT');
addColumnIfMissing('assessment_tasks', 'section_code', 'section_code TEXT');
addColumnIfMissing('assessment_tasks', 'skill_name', 'skill_name TEXT');
addColumnIfMissing('assessment_tasks', 'question_ref', 'question_ref INTEGER');
addColumnIfMissing('assessment_sessions', 'final_recommendation_ext', 'final_recommendation_ext TEXT');
// hidden auto-grading results per submission (JSON, admin-only — never sent to candidates)
addColumnIfMissing('assessment_answers', 'autograde', 'autograde TEXT');

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function now() {
  return Date.now();
}

export function recordEvent({ sessionId = null, candidateId = null, actorId = null, type, taskId = null, payload = null }) {
  db.prepare(
    `INSERT INTO assessment_events (session_id, candidate_id, actor_id, event_type, task_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, candidateId, actorId, type, taskId, payload ? JSON.stringify(payload) : null, now());
}

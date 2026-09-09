# Intern Technical Assessment Platform

An internal company platform for running short, staged technical assessments for internship
candidates. Bundled assessments:

- **20-Minute Cybersecurity Coding Test** (failed-login analysis → detection logic → suspicious
  successful logins → hidden IP-rotation follow-up → CV verification → AI/ML questions →
  server-side scoring → recommendation)
- **Basic Edition** (simplified 3-task version for walk-in screening, with hidden auto-grading)
- **Degree Intern — Python Technical Assessment** (question bank + CV-skill-driven generation,
  10–15 sequential questions incl. MCQ, practical coding, hidden requirement-change follow-ups,
  skill verification, 5-level scoring report) — see section 16.

The system is intentionally minimal but production-quality: one Node.js process, one SQLite
file, no external database service. It is designed so future assessments (Backend / Frontend /
Python / Cloud intern tests…) can be added **without rewriting the engine**.

---

## 1. Architecture overview

```
┌────────────────────────────────────────────────────────────────┐
│                        Browser                                 │
│  /candidate  (candidate SPA page)     /admin (interviewer SPA) │
│  vanilla JS + fetch, CSP: script-src 'self' (no inline JS)     │
└──────────────▲─────────────────────────────▲───────────────────┘
               │ JSON + SameSite=Strict      │ JSON
               │ session cookie              │
┌──────────────┴─────────────────────────────┴───────────────────┐
│  Express server (server.js)                                    │
│  ├── security headers / CSP / CSRF guard / rate limiting       │
│  ├── /api/auth        login, logout, me (scrypt + DB sessions) │
│  ├── /api/candidate   role=candidate only                      │
│  │     staged task delivery, server-side timer, versioned submits
│  └── /api/admin       role=admin only                          │
│        answer keys, scoring, notes, unlock, report, settings   │
├────────────────────────────────────────────────────────────────┤
│  src/db.js     node:sqlite (DatabaseSync), WAL, FK=ON          │
│  src/seed.js   assessment/task/section definitions + ANSWER KEYS │
│  src/candidate.js / src/admin.js / src/auth.js / src/indicators.js │
└────────────────────────────────────────────────────────────────┘
               │
        data/assessment.db  (single SQLite file, created on first run)
```

Key design decisions

- **Auto-grading engine (hidden from candidates).** When a candidate submits a coding task, the
  server executes their Python in an isolated subprocess (`python -I -S`, fresh temp dir, 4 s
  hard timeout, output caps) and checks the output twice: once against the sample dataset, and
  once against an **unseen variant dataset** injected by replacing the log block in their code.
  Solutions that hard-code the sample answers pass the first check but fail the second.
  Results (`AUTO-GRADE n/2 PASS/FAIL` with per-test details) are shown **only to the
  interviewer** on each submission version and stored on the answer row. Candidates can neither
  see the results nor probe them by resubmitting (submissions are versioned, results hidden).
  Isolation honesty: this is subprocess-level sandboxing — appropriate for an internal,
  low-stakes test. For hardened isolation, run the runner inside a locked-down container
  (`--network none`, memory/CPU caps) or point `PYTHON_BIN` at a locked-down interpreter.
  If Python is absent, grading is skipped and the UI says so (nothing is faked).
- **Answer keys live only in the backend** (`assessment_tasks.answer_key`, `scoring_guide`,
  `internal_answer`). The candidate API physically cannot return those columns — they are
  stripped in `sanitizeTask()` and never selected in candidate queries.
- **The timer is server-side.** `assessment_sessions.started_at` / `deadline_at` are set by the
  server on "Start Assessment"; every save/submit re-checks the deadline. Client clock, JS timer
  and localStorage manipulation have no effect. The browser only *displays* the remaining time
  (synced via server timestamps).
- **Task unlocking is derived server-side** from submitted answers, not from client state.
  The hidden follow-up additionally requires an explicit admin `reveal_followup` action.
- **Code execution is isolated and disclosed.** Candidates can press **Run** to execute their
  own code before submitting (`POST /api/candidate/run`): a fresh `python -I -S` subprocess per
  run, temp working dir, 4 s hard timeout, output caps, 12 runs/min per user, session-bound and
  audit-logged. **Auto-grading uses the same runner** — and runs each submission against the
  sample dataset plus an unseen variant dataset injected over the log block, so hard-coded
  sample answers fail the second check. Grading results are admin-only. Isolation honesty:
  subprocess-level sandboxing is appropriate for an internal, low-stakes test; for hardened
  isolation run the runner in a locked-down container (`--network none`, CPU/mem caps).
- **Integrity indicators ≠ cheating verdicts.** The server records events (saves, pastes,
  submissions, timings) and surfaces neutral signals with evidence. Judgement is the
  interviewer's.

## 2. Database ERD

```
users ──1:1── candidates ──1:N── assessment_sessions ──┬──1:N── assessment_answers
  │                                      │  ▲          ├──1:N── assessment_drafts
  │                                      │  │          ├──1:N── assessment_scores
  └──1:N── auth_sessions                 │  │          ├──1:N── interviewer_notes
                                         │  │          └──1:N── assessment_events
assessments ──1:N── assessment_tasks ────┘  │
     └──────1:N── assessment_score_sections │
              (per-assessment rubric) ──────┘
settings (recommendation thresholds, key/value)
```

Tables (all in `src/db.js`):

| table | purpose |
|---|---|
| `users` | auth identity (`admin` / `candidate` role), scrypt password hash |
| `auth_sessions` | login sessions (SHA-256 token hashes; the raw token lives only in the cookie) |
| `candidates` | candidate profile, 1:1 with a candidate user |
| `assessments` | an assessment definition (title, instructions, duration) |
| `assessment_tasks` | ordered tasks: `prompt_html`, `data_text`, `starter_code`, **`answer_key`, `scoring_guide`, `internal_answer`**, `unlock_mode` (`after_previous` / `admin_reveal` / `never_candidate`) |
| `assessment_score_sections` | scoring rubric per assessment (code, label, max score) |
| `assessment_sessions` | one candidate × assessment run: status, started/deadline/completed timestamps, recommendation |
| `assessment_drafts` | latest auto-saved draft per task (+ save/paste counters for integrity) |
| `assessment_answers` | **versioned** submissions — old versions are never overwritten |
| `assessment_scores` | score per rubric section + override flag + editor |
| `interviewer_notes` | free-text interviewer notes |
| `assessment_events` | audit trail: `ASSESSMENT_STARTED`, `TASK_OPENED`, `ANSWER_SAVED`, `ANSWER_SUBMITTED`, `TASK_UNLOCKED`, `FOLLOWUP_REVEALED`, `ASSESSMENT_COMPLETED`, `TIME_EXPIRED`, `SCORE_SET`, `SCORE_UPDATED`, `LOGIN_OK/FAILED`, … |
| `settings` | configurable recommendation thresholds |
| `candidate_skills` | candidate's claimed CV skills (`skill_name`, `claimed_level`, `source`) |
| `question_bank` | Python assessment pool: category / skill / difficulty / type / points / hidden follow-ups / version; answer keys live here and are copied into materialised tasks |
| `assessment_skill_mapping` | per-assessment skill → weight |
| `assessment_skill_results` | per-session claimed-skill verification (VERIFIED / PARTIALLY VERIFIED / NOT VERIFIED / NOT TESTED) |

Session statuses: `NOT_STARTED → IN_PROGRESS → SUBMITTED → COMPLETED → REVIEWED`, with
`TIME_EXPIRED` when the deadline passes before completion.

## 3. API documentation

All requests are JSON. Mutating requests must send `Content-Type: application/json` **and**
`X-Requested-With: fetch` (CSRF guard; cookies are `SameSite=Strict`).

### Auth
| method & path | role | description |
|---|---|---|
| `POST /api/auth/login` `{username,password}` | any | sets HttpOnly session cookie; rate-limited 10/min per IP+username |
| `POST /api/auth/logout` | any | destroys the server session |
| `GET /api/auth/me` | any | `{username, role, displayName}` |

### Candidate (`/api/candidate`, requires role=candidate; answers/keys never included)
| method & path | description |
|---|---|
| `GET /assessment/current` | the **only** data source for the candidate UI: status, server timer, current task (prompt/data/starter/own draft), visible progress. Hidden tasks, keys and rubric are excluded. |
| `POST /assessment/start` | starts the 20-minute window server-side |
| `POST /tasks/:taskId/save` | auto/manual draft save; rejects future tasks & expired sessions |
| `POST /tasks/:taskId/submit` | versioned submission; unlocks the next sequential task; `EXPLANATION_REQUIRED` where configured |
| `POST /assessment/complete` | final submission (all sequential tasks submitted; candidate confirms in UI) |
| `POST /events` | optional client-side integrity telemetry (paste sizes) |

### Admin (`/api/admin`, requires role=admin)
| method & path | description |
|---|---|
| `GET /candidates` | list candidates + latest session status |
| `POST /candidates` `{name,email,position}` | creates candidate user + session; returns a **one-time password** (shown once, stored only as scrypt hash) |
| `DELETE /candidates/:id` | deletes the candidate **and** all their sessions, submissions, drafts, scores, notes and audit events (transactional; admin only) |
| `GET /assessments/:sessionId` | full detail: tasks **with answer keys / scoring guides / internal answers**, all submission versions, drafts, scores, notes, events, integrity indicators, live total + recommendation |
| `POST /assessments/:id/unlock-task` `{action:'reveal_followup'}` | reveals the hidden scenario to that candidate |
| `POST /assessments/:id/score` `{sectionCode,score}` | sets a section score (server-side validation 0..max; second edit ⇒ `is_override`) |
| `POST /assessments/:id/notes` `{note}` | append an interviewer note |
| `POST /assessments/:id/finalize` `{recommendation?}` | marks `REVIEWED`, stores manual recommendation (or auto) |
| `GET /assessments/:id/report` | report JSON (scores, task results, indicators, notes; Python sessions add skill verification + score level) |
| `GET/POST /settings` | recommendation thresholds (strong pass / pass / review) |
| `GET /python-assessments/catalog` | Python module catalog (skills, dimensions, modes, question-pool stats) |
| `POST /python-assessments` | generates a Python assessment for a candidate: `{candidateId, mode, randomize, durationSeconds, skills?}` |
| `GET /candidates/:id/skills` | candidate's claimed skill profile |
| `PUT /candidates/:id/skills` | replaces the skill profile `{skills:[{skillName,claimedLevel}]}` |

Errors are machine-readable: `401 NOT_AUTHENTICATED`, `403 FORBIDDEN / TASK_NOT_UNLOCKED /
TIME_EXPIRED / CSRF_CHECK_FAILED`, `409 ALREADY_STARTED / SESSION_NOT_ACTIVE`, `429 RATE_LIMITED`.

## 4. Frontend route structure

| route | page | access |
|---|---|---|
| `/` | login (redirects by role) | public |
| `/candidate` | candidate assessment screen | role=candidate |
| `/admin` | interviewer dashboard | role=admin |

Candidate screen states: instructions (`NOT_STARTED`) → task view (code editor + answer +
explanation) → `WAITING_INTERVIEWER` → follow-up scenario → `READY_TO_FINISH` → completed /
`TIME_EXPIRED`. The client state machine is driven entirely by `GET /api/candidate/assessment/current`
(polled every 4 s) — the server is the source of truth.

## 5. Backend package structure

```
assessment-platform/
├── server.js              # entry: middleware, auth routes, static pages, mounting
├── src/
│   ├── db.js              # schema creation + additive migrations, settings & event helpers
│   ├── seed.js            # cybersecurity seed + Python seed (question bank, demo candidate)
│   ├── simpleCyberAssessment.js  # Basic Edition seed (walk-in screening set)
│   ├── pythonQuestions.js # Python question bank definition (23 items + hidden follow-ups)
│   ├── pythonAssessment.js# Python generator: modes, selection, rubric, skill verification
│   ├── runner.js          # subprocess Python executor (python -I -S, timeout, output caps)
│   ├── autograde.js       # hidden auto-grading with anti-hardcode variant datasets
│   ├── cheatsheet.js      # interviewer-only printable answer booklet
│   ├── auth.js            # scrypt, DB-backed sessions, cookies, RBAC, CSRF, rate limiting
│   ├── candidate.js       # staged delivery, server-side timer, versioned submissions
│   ├── admin.js           # answer keys, scoring engine, notes, unlock, report, settings,
│   │                      #   Python generation + skill-profile endpoints
│   └── indicators.js      # integrity indicators (neutral, evidence-based)
├── public/
│   ├── index.html / candidate.html / admin.html
│   ├── css/app.css
│   └── js/common.js / candidate.js / admin.js
├── tests/run-tests.mjs    # automated assertions (cybersec + basic + python flows)
└── data/assessment.db     # created at first run (gitignored)
```

## 6. Security model

| requirement | implementation |
|---|---|
| Authentication | scrypt-hashed passwords (`s1$salt$hash`), DB-backed opaque session tokens, HttpOnly + SameSite=Strict cookie, 8 h expiry |
| Authorization / RBAC | every route guarded by `requireRole('candidate'|'admin')`; candidate API has no session-id parameter — it is derived from the caller's identity, so cross-candidate access is impossible by construction |
| Server-side timer | `started_at`/`deadline_at` set and enforced server-side; grace of 1.5 s for network latency; `TIME_EXPIRED` recorded once |
| Server-side task unlocking | current task derived from submissions; future/unrevealed tasks rejected with `TASK_NOT_UNLOCKED`; hidden follow-up needs admin reveal |
| Answer-key protection | keys/rubric/internal answers live in admin-only columns and responses; candidate responses built field-by-field; CSP forbids inline script so even a stored XSS cannot exfiltrate |
| SQL injection | 100 % prepared statements via `node:sqlite` |
| XSS | all user content rendered through `esc()`; CSP `default-src 'self'; script-src 'self'` (no inline JS anywhere); `X-Content-Type-Options: nosniff` |
| CSRF | SameSite=Strict cookies + JSON content-type + `X-Requested-With: fetch` header on mutations (verified by tests) |
| Rate limiting | login 10/min per IP+username; in-memory limiter (per-process) |
| Audit logs | `assessment_events` records every meaningful action with timestamps and actor |
| Password handling | candidate passwords are generated one-time and shown **once** to the interviewer; only scrypt hashes are stored |
| No invasive surveillance | no camera/mic/filesystem access; `Permissions-Policy` explicitly denies camera/microphone/geolocation |

## 7. Assessment flow (implemented)

```
Admin creates candidate ──► candidate receives one-time credentials
        ▼
Candidate logs in ──► instructions ──► presses "Start Assessment" ──► server sets 20:00 deadline
        ▼
Task 1  (count FAILED per IP)  ──submit──►  Task 2 unlocks
Task 2  (SUSPICIOUS rule)      ──submit──►  Task 3 unlocks
Task 3  (suspicious successes + why-it's-serious explanation) ──submit──► SUBMITTED
        ▼  (candidate waits; timer keeps running)
Interviewer clicks "Reveal to candidate" ──► hidden IP-Rotation scenario appears
Candidate answers ──► "Submit Final Assessment" ──► COMPLETED
        ▼  (interviewer-only, no timer)
CV verification (5 verbal questions, guidance + red flags) · AI/ML follow-up
        ▼
Interviewer scores each rubric section ──► server totals ──► recommendation
        ▼
Finalize ──► REVIEWED ──► Generate report (printable / PDF)
```

Timestamps stored: `started_at`, `deadline_at`, per-task `TASK_OPENED`, per-submission
`submitted_at` + `time_spent_ms`, `final_submitted_at`, `completed_at`, `reviewed_at`.

## 8. Scoring model

Seeded rubric for the cybersecurity test (defined per-assessment in `assessment_score_sections`,
so other assessments can use their own):

| section | max |
|---|---|
| Task 1 — Failed Login Analysis | 20 |
| Task 2 — Suspicious Login Detection | 20 |
| Task 3 — Suspicious Successful Login | 20 |
| Hidden Scenario — IP Rotation | 15 |
| CV Verification | 20 |
| AI/ML Understanding | 5 |
| **Total** | **100** |

- Scores are entered per section by the interviewer and **totalled server-side**.
  Editing a score twice flags it as `OVERRIDE`.
- Recommendation thresholds (configurable via `POST /api/admin/settings`):
  **≥85 STRONG PASS · 70–84 PASS · 55–69 REVIEW · <55 FAIL**.
- A manual final recommendation can override the automatic one at finalize time.

> Note: the spec contains two conflicting rubrics (task-based 20/20/20/15/20/5 vs a
> skill-based 20/10/15/15/15/10/10/5). The task-based one matching the dashboard example was
> implemented; because the rubric is data, a skill-based rubric can be adopted by editing the
> seeded sections without code changes.

## 9. Test results

`npm test` spins an isolated server + scratch DB and runs **136 assertions** — current
status: **136/136 passing**.

Covered: all 20 required cybersecurity cases (start & timer, key invisibility, staged
unlocks, expiry, role boundaries, scoring, versioning, isolation, XSS/SQLi/CSRF, rate
limiting, deletion cascade) · auto-grading engine (generic solutions pass sample + unseen
datasets, hard-coded answers fail the unseen variant, results never exposed) · interviewer
answer booklet access control · **Python module:** catalog & RBAC, skill-profile CRUD +
validation, CV-skill generation (10–15 questions, rubric rescaled to 100), server-side
30-minute timer, no key/guide leakage, hidden follow-ups invisible up front and revealed
only after the parent, masked future progress titles, full sequential walk incl. MCQ,
READY_TO_FINISH without interviewer unlock, completion, post-completion rejection,
server-side total, score level, thresholds → recommendation, skill verification statuses
(VERIFIED / NOT VERIFIED + requires-review / NOT TESTED), report contents, ext
recommendation finalize, standard & interview-followup modes, unknown-candidate 404.

## 10. Known limitations (deliberate, first version)

- **Subprocess-level sandbox.** Run and auto-grading execute candidate Python in an isolated
  subprocess (`-I -S`, timeout, temp cwd), which is right for an internal test but is not
  container-grade isolation. For hardened deployment run the runner inside a container with
  `--network none` and CPU/memory caps — do **not** `eval`/`exec` in the API process.
- Rate limiting and integrity telemetry are in-memory (single-process). Use Redis if you scale
  horizontally.
- Integrity indicators are heuristic; a pasted answer is not proof of AI use — that is why they
  are presented as neutral signals with evidence.
- No password self-service (interviewer resets via new one-time password), no pagination, no
  multi-assessment assignment UI yet (engine + schema already support multiple assessments).
- Anti-cheat paste telemetry is best-effort client reporting; treat it as a weak signal.

## 11. How to run locally

```bash
cd assessment-platform
npm install
npm start          # http://localhost:3000
# or: npm run dev  (auto-restart on file changes)
npm test           # isolated test run (69 assertions)
```

Environment variables: `PORT` (default 3000), `DB_PATH` (default `./data/assessment.db`),
`APP_SECRET` (reserved for future signed payloads).

## 12. How to deploy

1. Provision a Linux VM; install Node.js ≥ 22.
2. Copy the `assessment-platform` folder; `npm ci --omit=dev`.
3. Run behind a reverse proxy with TLS (Caddy/nginx), e.g.
   `caddy reverse-proxy --from assess.example.com --to 127.0.0.1:3000` — TLS makes the session
   cookie `Secure` automatically.
4. Keep `data/` on persistent storage and back it up (it contains all submissions + notes).
5. Restrict admin routes to the office network/VPN at the proxy if desired.
6. Process management: `systemd` unit or `pm2 start server.js`.

## 13. Default admin setup

- Username `admin`, password `admin123` — **created on first run**.
- Change it immediately in a real assessment round: replace the row with a new scrypt hash, or
  delete the seeded admin and register your own (see `src/seed.js`). Session cookies are
  invalidated by restarting with a fresh DB.

## 14. Sample candidate accounts

- Username `johntan`, password `candidate123`, pre-assigned to the cybersecurity assessment
  (status `NOT_STARTED`).
- Username `susanlim`, password `candidate123`, pre-assigned to a generated **Python
  Technical Assessment** (CV skill profile included) — demo for the Python module.
- Real candidates should be created through **Interviewer Dashboard → + New candidate**, which
  generates a username and a one-time password (displayed once); use "🐍 New Python
  assessment" (or the 🐍 button on a candidate row) to generate their Python assessment.

## 15. How to add another assessment later

The engine is data-driven. To add a "Python Developer Intern Test":

1. In `src/seed.js` (or a new seed module), insert a new row into `assessments`
   (unique `slug`, title, instructions, `duration_seconds`).
2. Insert its `assessment_tasks` — sequential ones with `unlock_mode='after_previous'`, any
   interviewer-revealed twist with `unlock_mode='admin_reveal'`, interviewer-only sections with
   `unlock_mode='never_candidate'`. Put expected results in `answer_key` / `scoring_guide` /
   `internal_answer` — they automatically appear only on the admin dashboard.
3. Insert its rubric rows into `assessment_score_sections` (they define the max total).
4. Deactivate the old assessment (`is_active = 0`) if only one should be live at a time, then
   create candidates — new sessions automatically bind to the active assessment.

No changes to routes, timer logic, delivery logic, or UI code are required.

---

## 16. Degree Intern — Python Technical Assessment module

A fully data-driven extension for degree-level internship candidates (CS / SE / DS / AI / IT).
It reuses the existing engine — authentication, candidates, sessions, server-side timer,
sequential unlocking, versioned submissions, rubric scoring, reports — and adds a question
bank plus a per-candidate generator.

### 16.1 Purpose & format

Measures whether the candidate can *use* Python to solve practical problems: fundamentals,
data structures, functions, CSV/Pandas processing, data cleaning, exception handling,
debugging, API usage, web scraping (incl. ethics), automation-style tasks, problem solving,
code quality and the ability to explain their solution. Not a syntax-recall test.

Default duration **30 minutes** (server-side, configurable per generation). A generated
assessment contains **10–15 questions** across sections A–G, always including practical
coding and a technical-explanation question — never a pure-MCQ test.

### 16.2 Assessment modes

| mode | behaviour |
|---|---|
| `standard` | Fixed question sequence across all 7 question categories + Code Quality rubric row. |
| `cv_skill` | Questions generated from the candidate's **skill profile**. General baselines (fundamentals, data processing, debugging, practical coding, explanation) are always included; CSV/Pandas, API and Scraping appear only when claimed. Unclaimed technologies are never tested. |
| `interview_followup` | Short practical set; requirement-change follow-ups are materialised as `interviewer_only` tasks the interviewer asks verbally. |

`randomize` (admin-configurable) shuffles each category pool before picking; otherwise the
fixed pool order is used. **Question count is configurable**: leave it empty for the balanced
default (13 questions), or enter a target (e.g. 20) — the planner distributes it across the
included dimensions proportionally to rubric weight, clamped to each dimension's pool, and the
dialog shows a live composition preview (per-section chips, hidden follow-up estimate and a
suggested duration) via `POST /api/admin/python-assessments/preview` before anything is created. Rubric weights (Fundamentals 15, Data Processing 15, CSV/Pandas 15,
Debugging 15, API/Web 10, Scraping 10, Problem Solving 10, Code Quality 5, Explanation 5) are
**rescaled so every generated assessment totals exactly 100 points**.

### 16.3 Question bank (`src/pythonQuestions.js` → `question_bank`)

23 items: 5 fundamentals (2 MCQ), 4 data processing, 4 CSV/Pandas, 4 debugging (+1 hidden
follow-up "what if amount is None?"), 3 web/API, 3 scraping (+2 hidden follow-ups: empty
table, table→div redesign), 2 practical coding (+2 hidden requirement-change follow-ups:
duplicate rows, inconsistent timestamps), 2 explanation. Each entry carries difficulty,
type, points, answer key, scoring guide and internal interviewer notes. Hidden follow-ups
(`is_hidden=1`, `followup_of`) materialise **only when their parent question is selected**,
directly after it — the candidate cannot see them before submitting the parent answer.

### 16.4 Skill verification

After scoring, each claimed skill gets a status persisted in `assessment_skill_results`:

- **VERIFIED** ≥ 75% on the related sections · **PARTIALLY VERIFIED** ≥ 50% ·
  **NOT VERIFIED** < 50% · **NOT TESTED** — no mapped questions existed (SQL / ML are never
  generated; the wording explicitly never claims the candidate "does not know it").
- **Mismatch detection:** a claim of *Advanced/Expert* Python with < 60% demonstrated on the
  related sections produces *"Claimed Skill vs Demonstrated Skill requires review"* — an
  interviewer-judgement hint, never an accusation.

### 16.5 Scoring levels & recommendation

Because the rubric always totals 100, the percentage is the raw total:
**≥90 Excellent · 75–89 Strong · 60–74 Acceptable · 40–59 Weak · <40 Insufficient** — shown
on the dashboard and the report. Auto-recommendation: ≥90 Strong Fit, ≥75 Suitable,
≥60 Suitable With Supervision, ≥40 Further Interview, <40 Not Recommended (stored exactly in
`final_recommendation_ext`, mapped onto the generic 4-value enum for compatibility).

### 16.6 Anti-cheating (spec §4)

Sequential server-side unlocking (future questions rejected with `TASK_NOT_UNLOCKED`), one
server-side timer, hidden follow-ups revealed only after the parent submission, requirement
changes, versioned submissions with timestamps, paste telemetry, and **masked titles in the
progress bar** (not-yet-reached questions show "Q n" only, so future content never leaks).
No webcam, microphone, or invasive monitoring anywhere.

### 16.7 UI

- **Interviewer dashboard:** "🐍 New Python assessment" opens a dialog with candidate,
  mode, duration, randomization and an editable skill-chip editor (saved to the CV profile;
  every candidate row also has a 🐍 shortcut). Python sessions show a **Claimed skill
  verification** card, score-level badge, weighted rubric rows and the 5-option
  recommendation select. The report renders the skill-verification table and level.
- **Candidate screen:** brand + title follow the assigned assessment, "Question n of m"
  counter, MCQ rendered as radio options (stored in the same versioned `answer` field),
  Python code editor with syntax highlighting, explanation box where required.
- Sample candidate seeded for demo: **susanlim / candidate123** (CV: Python advanced,
  Pandas intermediate, Web Scraping intermediate, SQL intermediate, ML beginner) with a
  pre-generated CV-skill assessment.

No external AI/LLM API is used anywhere; selection, timer, scoring and verification are
purely server-side.

### 16.8 Related assessment materials (`docs/`)

- [`docs/实习生职场行为与工作能力测评_中文版.docx`](docs/实习生职场行为与工作能力测评_中文版.docx) —
  中文版《实习生职场行为与工作能力测评》：19 道职场情境判断题(沟通、责任、团队合作、专业判断、
  执行力)+ 1 道开放式问题。作为平台后续"软技能 / 职场行为测评"模块的题源材料
  (situational-judgment test; a future engine mode can materialise these as MCQ tasks and
  score them per competency dimension)。

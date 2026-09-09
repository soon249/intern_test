import { runPython, pythonAvailable } from './runner.js';

// The canonical 11-line log from the starter code (used to locate & swap the dataset).
const ORIGINAL_LOG_LINES = [
  '10:01:02 | 10.0.0.5  | admin | FAILED',
  '10:01:05 | 10.0.0.8  | user  | SUCCESS',
  '10:01:07 | 10.0.0.5  | admin | FAILED',
  '10:01:11 | 10.0.0.5  | root  | FAILED',
  '10:01:15 | 10.0.0.5  | test  | FAILED',
  '10:01:19 | 10.0.0.5  | admin | SUCCESS',
  '10:01:25 | 10.0.0.9  | user  | FAILED',
  '10:02:01 | 10.0.0.5  | root  | FAILED',
  '10:02:10 | 10.0.0.5  | root  | SUCCESS',
  '10:02:15 | 10.0.0.8  | user  | SUCCESS',
  '10:03:01 | 10.0.0.5  | guest | FAILED'
];

// Hidden variant dataset: if the candidate hard-codes the sample answers instead of
// implementing the logic, the default-log test may pass but this one will fail.
const VARIANT_LOG = [
  '11:00:01 | 172.16.0.9 | admin | FAILED',
  '11:00:04 | 172.16.0.9 | admin | FAILED',
  '11:00:07 | 172.16.0.4 | root  | FAILED',
  '11:00:10 | 172.16.0.9 | guest | FAILED',
  '11:00:13 | 172.16.0.4 | root  | SUCCESS',
  '11:00:16 | 172.16.0.7 | user  | SUCCESS'
].join('\n');

// task1: count FAILED per IP + MOST_FAILED line
// task2: SUSPICIOUS iff failed >= 3 AND >= 2 distinct usernames
// task3: successes that follow >= 1 earlier FAILED from the same IP
export const AUTO_TESTS = {
  task1: [
    { name: 'sample dataset', variant: false, expect: { pairs: { '10.0.0.5': 6, '10.0.0.8': 0, '10.0.0.9': 1 }, most: '10.0.0.5' } },
    { name: 'unseen dataset (anti-hardcode)', variant: true, expect: { pairs: { '172.16.0.9': 3, '172.16.0.4': 1 }, most: '172.16.0.9' } }
  ],
  task2: [
    { name: 'sample dataset', variant: false, expect: { flags: { '10.0.0.5': 'SUSPICIOUS', '10.0.0.8': 'NORMAL', '10.0.0.9': 'NORMAL' } } },
    { name: 'unseen dataset (anti-hardcode)', variant: true, expect: { flags: { '172.16.0.9': 'SUSPICIOUS', '172.16.0.4': 'NORMAL' } } }
  ],
  task3: [
    { name: 'sample dataset', variant: false, expect: { suspicious: [['10.0.0.5', 'admin'], ['10.0.0.5', 'root']] } },
    { name: 'unseen dataset (anti-hardcode)', variant: true, expect: { suspicious: [['172.16.0.4', 'root']] } }
  ],
  // basic edition: same logs, elementary mechanics
  b1: [
    { name: 'sample dataset', variant: false, expect: { count: 7, label: 'FAILED' } },
    { name: 'unseen dataset (anti-hardcode)', variant: true, expect: { count: 3, label: 'FAILED' } }
  ],
  b2: [
    { name: 'sample dataset', variant: false, expect: { count: 5, label: 'USERS' } },
    { name: 'unseen dataset (anti-hardcode)', variant: true, expect: { count: 3, label: 'USERS' } }
  ],
  b3: [
    { name: 'sample dataset', variant: false, expect: { names: ['admin', 'root'] } },
    { name: 'unseen dataset (anti-hardcode)', variant: true, expect: { names: ['admin'] } }
  ]
};

// Variant dataset for the basic edition (b1/b2/b3): FAILED lines = 3,
// distinct usernames = 3 (admin, root, user), both-FAILED-and-SUCCESS = admin.
const VARIANT_LOG_BASIC = [
  '11:00:01 | 172.16.0.9 | admin | FAILED',
  '11:00:04 | 172.16.0.9 | admin | SUCCESS',
  '11:00:07 | 172.16.0.4 | root  | FAILED',
  '11:00:11 | 172.16.0.4 | root  | FAILED',
  '11:00:14 | 172.16.0.7 | user  | SUCCESS'
].join('\n');

function swapLogs(code, variantLog) {
  const blockRe = new RegExp(
    ORIGINAL_LOG_LINES[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, ' +') +
    '[\\s\\S]*?' +
    ORIGINAL_LOG_LINES[ORIGINAL_LOG_LINES.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, ' +')
  );
  if (!blockRe.test(code)) return null;
  return code.replace(blockRe, variantLog);
}

const IP_RE = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;

function checkTask1(stdout, expect) {
  const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const pairs = {};
  for (const line of lines) {
    const m = line.match(new RegExp(`^(${IP_RE})\\s*(?:->|→|=>|:=|:|=)\\s*(\\d+)\\s*$`));
    if (m) pairs[m[1]] = Number(m[2]);
  }
  const mostLine = lines.find(l => /^MOST_FAILED/i.test(l));
  const most = mostLine ? (mostLine.match(new RegExp(`(${IP_RE})`)) || [])[1] : undefined;
  const problems = [];
  for (const [ip, n] of Object.entries(expect.pairs)) {
    if (pairs[ip] !== n) problems.push(`${ip}: expected ${n}, got ${pairs[ip] === undefined ? 'no output' : pairs[ip]}`);
  }
  if (most !== expect.most) problems.push(`MOST_FAILED: expected ${expect.most}, got ${most ?? 'no output'}`);
  return { passed: problems.length === 0, detail: problems.join('; ') || `matches (${Object.keys(expect.pairs).length} IPs + MOST_FAILED)` };
}

function checkTask2(stdout, expect) {
  const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const flags = {};
  for (const line of lines) {
    const m = line.match(new RegExp(`^(${IP_RE})\\s*(?:->|→|=>|:=|:|=)\\s*(SUSPICIOUS|NORMAL)\\s*$`, 'i'));
    if (m) flags[m[1]] = m[2].toUpperCase();
  }
  const problems = [];
  for (const [ip, flag] of Object.entries(expect.flags)) {
    if (flags[ip] !== flag) problems.push(`${ip}: expected ${flag}, got ${flags[ip] === undefined ? 'no output' : flags[ip]}`);
  }
  return { passed: problems.length === 0, detail: problems.join('; ') || `matches (${Object.keys(expect.flags).length} IPs)` };
}

function checkTask3(stdout, expect) {
  const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const found = [];
  for (const line of lines) {
    const m = line.match(new RegExp(`^(${IP_RE})\\s*\\|\\s*(\\S+)\\s*\\|\\s*SUSPICIOUS\\s+SUCCESS`, 'i'));
    if (m) found.push([m[1], m[2].toLowerCase()]);
  }
  const want = expect.suspicious.map(([ip, u]) => `${ip}|${u.toLowerCase()}`).sort();
  const got = found.map(([ip, u]) => `${ip}|${u}`).sort();
  const problems = [];
  for (const w of want) if (!got.includes(w)) problems.push(`missing ${w}`);
  for (const g of got) if (!want.includes(g)) problems.push(`unexpected ${g} (false positive)`);
  return { passed: problems.length === 0, detail: problems.join('; ') || `matches (${got.length} entries)` };
}

function checkCount(stdout, expect) {
  const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let value;
  for (const line of lines) {
    const m = line.match(new RegExp(`^${expect.label}\\s*[:\\-]?\\s*(\\d+)\\s*$`, 'i'));
    if (m) { value = Number(m[1]); break; }
  }
  if (value === undefined && lines.length === 1 && /^\d+$/.test(lines[0])) value = Number(lines[0]);
  return {
    passed: value === expect.count,
    detail: value === undefined ? `no "${expect.label}: <n>" line found` : (value === expect.count ? `correct (${value})` : `expected ${expect.count}, got ${value}`)
  };
}

function checkNames(stdout, expect) {
  const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const found = new Set();
  for (const line of lines) {
    const m = line.match(/^(\S+)\s*\|\s*SUSPICIOUS(\s+LOGIN)?\s*$/i);
    if (m) found.add(m[1].toLowerCase());
  }
  const want = new Set(expect.names.map(n => n.toLowerCase()));
  const missing = [...want].filter(n => !found.has(n));
  const extra = [...found].filter(n => !want.has(n));
  const problems = [];
  if (missing.length) problems.push(`missing: ${missing.join(', ')}`);
  if (extra.length) problems.push(`unexpected (false positive): ${extra.join(', ')}`);
  return { passed: problems.length === 0, detail: problems.join('; ') || `matches (${found.size} entries)` };
}

const CHECKERS = {
  task1: checkTask1, task2: checkTask2, task3: checkTask3,
  b1: checkCount, b2: checkCount, b3: checkNames
};

/**
 * Runs the hidden test suite against a submitted solution.
 * Result: { available, ranAt, tests: [{name, passed, skipped, detail}], error? }
 * Never returned to the candidate — admin-only information.
 */
export async function autograde(taskCode, code) {
  const tests = AUTO_TESTS[taskCode];
  if (!tests) return null;
  if (!(await pythonAvailable())) {
    return { available: false, ranAt: Date.now(), tests: [], error: 'Python not installed on server — auto-grading skipped' };
  }
  const results = [];
  const variantLog = /^b\d$/.test(taskCode) ? VARIANT_LOG_BASIC : VARIANT_LOG;
  for (const t of tests) {
    let program = code;
    if (t.variant) {
      program = swapLogs(code, variantLog);
      if (program == null) {
        results.push({ name: t.name, passed: false, skipped: true, detail: 'original dataset not found in submission — variant run skipped' });
        continue;
      }
    }
    const run = await runPython(program, { timeoutMs: 4000 });
    if (!run.ok) {
      results.push({ name: t.name, passed: false, skipped: false, detail: run.message || 'execution unavailable' });
      continue;
    }
    if (run.timedOut) {
      results.push({ name: t.name, passed: false, skipped: false, detail: `timed out (>4s) or crashed (exit ${run.exitCode})` });
      continue;
    }
    const verdict = CHECKERS[taskCode](run.stdout, t.expect);
    results.push({
      name: t.name,
      passed: verdict.passed,
      skipped: false,
      detail: verdict.detail + (run.exitCode !== 0 ? ` | exit ${run.exitCode}${run.stderr ? `; stderr: ${run.stderr.slice(0, 160)}` : ''}` : '')
    });
  }
  return { available: true, ranAt: Date.now(), tests: results };
}

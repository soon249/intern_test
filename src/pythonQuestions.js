import { db, now } from './db.js';

/**
 * Degree Intern — Python Technical Assessment: question bank + skill catalog.
 *
 * Questions are stored in the `question_bank` table (never hardcoded in the UI).
 * The generator in pythonAssessment.js selects from this pool and materialises
 * rows into assessment_tasks, so the existing delivery engine (sequential
 * unlocking, server-side timer, versioned submissions, admin-only keys) is reused.
 *
 * Hidden follow-ups (is_hidden=1, followup_of=<parent code>) are only pulled in
 * when their parent question is selected — they materialise right after it, so
 * the candidate cannot see them before submitting the parent answer.
 */

export const DIMENSIONS = [
  { code: 'FUNDAMENTALS',    label: 'Python Fundamentals',   weight: 15 },
  { code: 'DATA_PROCESSING', label: 'Data Processing',       weight: 15 },
  { code: 'CSV_PANDAS',      label: 'CSV / Pandas',          weight: 15 },
  { code: 'DEBUGGING',       label: 'Debugging',             weight: 15 },
  { code: 'WEB_API',         label: 'API / Web',             weight: 10 },
  { code: 'SCRAPING',        label: 'Web Scraping',          weight: 10 },
  { code: 'PROBLEM_SOLVING', label: 'Problem Solving',       weight: 10 },
  { code: 'CODE_QUALITY',    label: 'Code Quality',          weight: 5  },
  { code: 'EXPLANATION',     label: 'Technical Explanation', weight: 5  }
];

// Skills an interviewer can record for a candidate (CV / manual input).
export const SKILL_CATALOG = [
  'Python', 'Pandas', 'NumPy', 'CSV Processing', 'Data Analysis',
  'Web Scraping', 'Requests', 'API', 'SQL', 'Machine Learning'
];

// Claimed CV skill → assessment dimensions that can verify it.
// Empty array = the engine never generates questions for it; it shows up
// as NOT TESTED in the skill verification (which does NOT mean "does not know it").
export const SKILL_DIMENSION_MAP = {
  'Python':          ['FUNDAMENTALS', 'DEBUGGING'],
  'Pandas':          ['CSV_PANDAS'],
  'NumPy':           ['DATA_PROCESSING'],
  'CSV Processing':  ['CSV_PANDAS', 'DATA_PROCESSING'],
  'Data Analysis':   ['DATA_PROCESSING', 'CSV_PANDAS'],
  'Web Scraping':    ['SCRAPING'],
  'Requests':        ['WEB_API'],
  'API':             ['WEB_API'],
  'SQL':             [],
  'Machine Learning': []
};

// Default selection counts per dimension for a generated assessment.
// MODE 1 (standard) uses the fixed pool order; MODE 2 shuffles when
// randomize is enabled. Admins can override perSection via the API.
export const DEFAULT_SECTION_COUNTS = {
  FUNDAMENTALS: 2, DATA_PROCESSING: 2, CSV_PANDAS: 2, DEBUGGING: 2,
  WEB_API: 1, SCRAPING: 2, PROBLEM_SOLVING: 1, EXPLANATION: 1
};

const TXN_LOG = `timestamp,username,amount,status,source
2026-09-01 10:00:01,userA,100,SUCCESS,web
2026-09-01 10:01:12,userB,abc,SUCCESS,web
2026-09-01 10:02:10,userA,50,FAILED,api
2026-09-01 10:03:22,userA,200,SUCCESS,web
2026-09-01 10:04:05,userC,,SUCCESS,mobile
2026-09-01 10:05:33,userB,75.5,SUCCESS,api
2026-09-01 10:06:41,userD,120,pending,web
2026-09-01 10:07:18,userA,RM 60,FAILED,web`;

export const QUESTIONS = [
  // ================= SECTION A — Python Fundamentals =================
  {
    code: 'PY_FUND_1', category: 'FUNDAMENTALS', skill_name: 'Python Fundamentals',
    difficulty: 'foundation', qtype: 'code', points: 8, explanation_required: 1, code_editor: 1,
    title: 'Aggregate transactions per user',
    prompt_html: `<p>You receive this list in a script that processes payments:</p>
<pre>transactions = [
    {"user": "A", "amount": 100},
    {"user": "B", "amount": 200},
    {"user": "A", "amount": 50}
]</pre>
<p><b>Task:</b> Write Python code that calculates the <b>total transaction amount for each user</b> and prints one line per user in the format <code>user=A total=150</code>.</p>
<p>Then explain in one or two sentences how your code groups the data.</p>`,
    starter_code: `transactions = [
    {"user": "A", "amount": 100},
    {"user": "B", "amount": 200},
    {"user": "A", "amount": 50}
]

# TODO: print the total amount per user
`,
    answer_key: `user=A total=150\nuser=B total=200`,
    scoring_guide: 'Correct dictionary aggregation (6) | Correct totals (2). Any correct implementation accepted (dict.get, defaultdict, Counter). Do NOT require one specific style — evaluate logic and readability. Partial credit if grouping logic is right but output format differs.',
    internal_answer: 'Tests dictionary aggregation: totals = {}; for t in transactions: totals[t["user"]] = totals.get(t["user"], 0) + t["amount"]. A candidate who loops over names and filters each time is less efficient — probe for that in the explanation.'
  },
  {
    code: 'PY_FUND_2', category: 'FUNDAMENTALS', skill_name: 'Python Fundamentals',
    difficulty: 'baseline', qtype: 'mcq', points: 3, explanation_required: 0, code_editor: 0,
    title: 'Choosing the right data structure',
    prompt_html: `<p>You are reading a log file and need to answer quickly: <i>"have I already seen this request ID?"</i> for hundreds of thousands of lines.</p>
<p><b>Which data structure is the most appropriate?</b></p>`,
    answer_options: JSON.stringify([
      'A list — append each ID and use `in` to check membership',
      'A set — add each ID and use `in` to check membership',
      'A tuple — because request IDs never change',
      'A dictionary mapping every ID to True, checked with .keys() only'
    ]),
    answer_key: 'A set — add each ID and use `in` to check membership',
    scoring_guide: 'Full credit only for the set option (2): O(1) average membership test. Choosing the dict variant (1/3) shows partial understanding. List (0): O(n) scans. Tuple (0): membership is still O(n).',
    internal_answer: 'Baseline question. Set membership is average O(1); list/tuple are O(n). The dict variant works but is heavier and less idiomatic.'
  },
  {
    code: 'PY_FUND_3', category: 'FUNDAMENTALS', skill_name: 'Python Fundamentals',
    difficulty: 'foundation', qtype: 'code', points: 6, explanation_required: 1, code_editor: 1,
    title: 'Normalise messy usernames',
    prompt_html: `<p>An upstream system delivers usernames in inconsistent formats:</p>
<pre>usernames = [" Alice ", "BOB", "char lie", "  DAVID\t", "Eve"]</pre>
<p><b>Task:</b> Write a function <code>normalise(names)</code> that returns clean usernames: trimmed, lower-case, with internal whitespace collapsed to a single underscore (e.g. <code>"char lie"</code> → <code>"char_lie"</code>). Print the cleaned list.</p>`,
    starter_code: `usernames = [" Alice ", "BOB", "char lie", "  DAVID\\t", "Eve"]

def normalise(names):
    # TODO: trim, lower-case, collapse whitespace to _
    pass
`,
    answer_key: `['alice', 'bob', 'char_lie', 'david', 'eve']`,
    scoring_guide: 'strip (2) | lower (2) | whitespace→underscore via split/join or replace+regex (2). Accept " ".join(s.split()).lower().replace(" ", "_") or a comprehension. Deduct 1 if tabs/newlines are not handled (split() without args handles them).',
    internal_answer: '" ".join(name.split()).lower().replace(" ", "_") is the idiomatic answer. Watch for candidates who only strip spaces and miss the tab in "  DAVID\\t".'
  },
  {
    code: 'PY_FUND_4', category: 'FUNDAMENTALS', skill_name: 'Python Fundamentals',
    difficulty: 'baseline', qtype: 'mcq', points: 3, explanation_required: 0, code_editor: 0,
    title: 'What does this loop print?',
    prompt_html: `<pre>result = []
for i in range(3):
    result.append(i * i)
print(result)</pre>
<p><b>Which output is correct?</b></p>`,
    answer_options: JSON.stringify(['[0, 1, 4]', '[1, 4, 9]', '[0, 1, 2]', '[0, 2, 6]']),
    answer_key: '[0, 1, 4]',
    scoring_guide: 'Correct answer only (3). This is a very short baseline check — a wrong answer here signals fundamentals problems to probe verbally, not an automatic fail.',
    internal_answer: 'range(3) = 0,1,2 → squares 0,1,4. If missed, check whether the candidate confuses 1-based ranges — common beginner error.'
  },
  {
    code: 'PY_FUND_5', category: 'FUNDAMENTALS', skill_name: 'Python Fundamentals',
    difficulty: 'intermediate', qtype: 'code', points: 8, explanation_required: 1, code_editor: 1,
    title: 'Safe numeric bucketing',
    prompt_html: `<p>Values arrive as strings, and some are not numbers at all:</p>
<pre>raw = ["12", "7.5", "x9", "300", "", "42"]</pre>
<p><b>Task:</b> Write code that puts each value into one of three buckets and prints the three lists:</p>
<ul><li><code>numbers</code> — successfully converted floats</li>
<li><code>invalid</code> — values that cannot be converted</li>
<li><code>empty</code> — empty/whitespace-only strings</li></ul>
<p>Add one sentence: what would happen without your guard, and why does that matter in a batch job?</p>`,
    starter_code: `raw = ["12", "7.5", "x9", "300", "", "42"]

# TODO: bucket into numbers / invalid / empty and print
`,
    answer_key: `numbers = [12.0, 7.5, 300.0, 42.0]\ninvalid = ['x9']\nempty = ['']`,
    scoring_guide: 'try/except around conversion (3) | empty-string handled separately or via strip check (2) | correct buckets (2) | explanation mentions one bad value would crash the whole loop (1).',
    internal_answer: 'Core concept: try: float(v) except ValueError. Strong candidates strip() first and treat "" as its own bucket. The explanation should connect one bad row → whole batch job dies → why validation matters.'
  },

  // ================= SECTION B — Data Processing =================
  {
    code: 'PY_DATA_1', category: 'DATA_PROCESSING', skill_name: 'Data Processing',
    difficulty: 'intermediate', qtype: 'code', points: 8, explanation_required: 1, code_editor: 1,
    title: 'Normalise an amount column before calculating',
    prompt_html: `<p>A CSV column <code>amount</code> contains:</p>
<pre>"100", "250.50", "RM 300", "invalid", "", "500"</pre>
<p><b>Question:</b> How would you normalise this column <b>before</b> performing calculations?</p>
<p>Write a function <code>clean_amount(value)</code> that returns a float or <code>None</code>, and print the cleaned list. Then briefly explain each rule you applied (currency symbols, text, empty strings).</p>`,
    starter_code: `values = ["100", "250.50", "RM 300", "invalid", "", "500"]

def clean_amount(value):
    # TODO: return float or None
    pass
`,
    answer_key: `[100.0, 250.5, None, None, None, 500.0]`,
    scoring_guide: 'Strips currency prefix/symbols ("RM 300" → 300.0) (3) | non-numeric text → None (2) | empty → None (2) | reasoning mentions type conversion + validation before aggregation (1). Accept regex or manual strip; accept NaN instead of None if stated.',
    internal_answer: 'Expected reasoning: trim → remove currency codes/symbols → try float() → decide a fallback (None/NaN/skip + log). Strong candidates mention logging how many rows were dropped instead of failing silently.'
  },
  {
    code: 'PY_DATA_2', category: 'DATA_PROCESSING', skill_name: 'Data Processing',
    difficulty: 'foundation', qtype: 'code', points: 6, explanation_required: 0, code_editor: 1,
    title: 'Sum orders per customer, skipping bad rows',
    prompt_html: `<pre>orders = [
    {"customer": "acme", "total": "120.50"},
    {"customer": "acme", "total": "oops"},
    {"customer": "zeta", "total": "80"},
    {"customer": "acme", "total": None},
]</pre>
<p><b>Task:</b> Print the total order value per customer, ignoring rows whose total is missing or not numeric. Format: <code>acme=120.5</code>, one per line.</p>`,
    starter_code: `orders = [
    {"customer": "acme", "total": "120.50"},
    {"customer": "acme", "total": "oops"},
    {"customer": "zeta", "total": "80"},
    {"customer": "acme", "total": None},
]

# TODO: totals per customer, skip invalid
`,
    answer_key: `acme=120.5\nzeta=80.0`,
    scoring_guide: 'None guard (2) | non-numeric guard (2) | correct aggregation (2). Candidates may convert then filter, or filter then convert — both fine.',
    internal_answer: 'Tests combining validation with aggregation. A candidate who crashes on None or "oops" is missing the guard they should have shown in PY_FUND_5 — note the inconsistency for the interviewer.'
  },
  {
    code: 'PY_DATA_3', category: 'DATA_PROCESSING', skill_name: 'Data Processing',
    difficulty: 'intermediate', qtype: 'scenario', points: 6, explanation_required: 1, code_editor: 0,
    title: 'Inconsistent timestamp formats',
    prompt_html: `<p>One CSV mixes date formats in the same column:</p>
<pre>2026-09-01
01/09/2026
Sep 1, 2026
2026/09/01 10:00</pre>
<p><b>Question:</b> How would you parse this column reliably? Describe your approach step by step (no full code needed) and name the Python facilities you would use.</p>`,
    answer_key: 'Try a list of known formats with datetime.strptime per format (or dateutil.parser.parse); normalise to one canonical format (e.g. ISO 8601); rows matching no format go to a rejects list with logging.',
    scoring_guide: 'strptime with multiple known formats OR dateutil (3) | normalising to a canonical representation (2) | rejects/audit path for unparseable rows rather than silent drops (1).',
    internal_answer: 'Watch for: assuming one format (breaks), ambiguous dd/mm vs mm/dd (ask verbally which locale), and pandas pd.to_datetime(format=..., errors="coerce") as a good answer.'
  },
  {
    code: 'PY_DATA_4', category: 'DATA_PROCESSING', skill_name: 'Data Processing',
    difficulty: 'baseline', qtype: 'mcq', points: 3, explanation_required: 0, code_editor: 0,
    title: 'First step when a CSV fails to load',
    prompt_html: `<p>A colleague runs <code>pd.read_csv("sales.csv")</code> and gets <code>ParserError: Error tokenizing data. C error: Expected 4 fields in line 87, saw 6</code>.</p>
<p><b>What is the most sensible first step?</b></p>`,
    answer_options: JSON.stringify([
      'Delete line 87 from the file and re-run',
      'Inspect line 87 and the surrounding rows to find why the field count differs (extra commas, unquoted text)',
      'Switch to json.load because the file is clearly not a CSV',
      'Pass encoding="utf-16" — ParserError always means an encoding problem'
    ]),
    answer_key: 'Inspect line 87 and the surrounding rows to find why the field count differs (extra commas, unquoted text)',
    scoring_guide: 'Full credit: inspect first (3). Deleting the line works but hides the cause (1). Encoding/json answers show misunderstanding of the error (0).',
    internal_answer: 'The error means the row has more separators than the header — usually unquoted commas or a multi-line field. Debugging reflex: look at the data before changing code.'
  },

  // ================= SECTION C — CSV / Pandas =================
  {
    code: 'PY_CSV_1', category: 'CSV_PANDAS', skill_name: 'CSV / Pandas',
    difficulty: 'intermediate', qtype: 'code', points: 10, explanation_required: 1, code_editor: 1,
    title: 'Clean a transactions CSV end-to-end',
    prompt_html: `<p>You receive <code>transactions.csv</code>:</p>
<pre>user_id,username,amount,status,timestamp
1,ann,100,SUCCESS,2026-09-01 10:00
2,ben,abc,SUCCESS,2026-09-01 10:01
2,ben,abc,SUCCESS,2026-09-01 10:01
3,cat,,FAILED,2026-09-01 10:02
4,dan,50,SUCCESS,2026-09-01 10:03</pre>
<p><b>Requirements:</b></p>
<ol><li>Remove duplicated rows.</li>
<li>Convert <code>amount</code> to numeric; ignore rows where it is invalid.</li>
<li>Count the <b>successful</b> transactions.</li>
<li>Calculate the total successful amount per user.</li>
<li>Export the cleaned result to <code>cleaned.csv</code> (or print the DataFrame if file writing is not convenient).</li></ol>
<p>Explain your choices briefly. You may use pandas or the standard library.</p>`,
    data_text: null,
    starter_code: `import pandas as pd

raw = """user_id,username,amount,status,timestamp
1,ann,100,SUCCESS,2026-09-01 10:00
2,ben,abc,SUCCESS,2026-09-01 10:01
2,ben,abc,SUCCESS,2026-09-01 10:01
3,cat,,FAILED,2026-09-01 10:02
4,dan,50,SUCCESS,2026-09-01 10:03
"""

# TODO: dedupe -> numeric conversion -> successful count -> totals per user -> export
`,
    answer_key: 'After dedupe: 4 rows. amount numeric: ben→NaN (dropped), cat→NaN (dropped). Successful count = 2 (ann, dan). Totals per user: ann=100.0, dan=50.0. cleaned.csv contains the deduped, numeric-valid rows.',
    scoring_guide: 'drop_duplicates (2) | pd.to_numeric(errors="coerce") + dropna or filter (3) | successful count filtered on status (2) | groupby/agg totals (2) | export or equivalent (1). Standard-library solution judged on the same concepts.',
    internal_answer: 'Expected pandas: df.drop_duplicates(); pd.to_numeric(df.amount, errors="coerce"); ok = df[df.amount.notna() & (df.status=="SUCCESS")]; ok.groupby("username").amount.sum(); ok.to_csv("cleaned.csv", index=False). Probe: why errors="coerce" rather than raising?'
  },
  {
    code: 'PY_CSV_2', category: 'CSV_PANDAS', skill_name: 'CSV / Pandas',
    difficulty: 'foundation', qtype: 'mcq', points: 3, explanation_required: 0, code_editor: 0,
    title: 'Removing duplicate rows in pandas',
    prompt_html: `<p>Which pandas call removes fully identical rows from a DataFrame <code>df</code>?</p>`,
    answer_options: JSON.stringify([
      'df.drop_duplicates()',
      'df.dropna()',
      'df.reset_index(drop=True)',
      'df.dissolve()'
    ]),
    answer_key: 'df.drop_duplicates()',
    scoring_guide: 'drop_duplicates (3). dropna (0) removes missing values — a common confusion worth probing verbally.',
    internal_answer: 'Baseline syntax check; understanding is verified by PY_CSV_1, so a miss here is not disqualifying by itself.'
  },
  {
    code: 'PY_CSV_3', category: 'CSV_PANDAS', skill_name: 'CSV / Pandas',
    difficulty: 'intermediate', qtype: 'scenario', points: 6, explanation_required: 1, code_editor: 0,
    title: 'Missing values: drop, fill, or keep?',
    prompt_html: `<p>In a payments dataset the <code>amount</code> column is missing for ~2% of rows, and <code>status</code> is <code>FAILED</code> for many of them.</p>
<p><b>Question:</b> Would you drop those rows, fill the missing amounts, or keep them as-is? Justify your choice and name the risk of the other two options.</p>`,
    answer_key: 'It depends on the purpose: for money totals, FAILED rows should not contribute anyway — filter by status first, then dropna on amount for what remains; filling with 0/mean would fabricate money values and bias totals; blanket dropping could discard otherwise-usable rows.',
    scoring_guide: 'Purpose-driven answer, not a reflex (2) | recognises status/context before deciding (2) | names a concrete risk of fill (fabricated values / bias) or of drop (losing rows) (2). No single "correct" choice — score the reasoning.',
    internal_answer: 'This is a judgement question. Red flag: "always fillna(0)" or "always dropna" without considering what the rows mean. Strong: distinguishes reporting vs. modelling use.'
  },
  {
    code: 'PY_CSV_4', category: 'CSV_PANDAS', skill_name: 'CSV / Pandas',
    difficulty: 'foundation', qtype: 'code', points: 6, explanation_required: 0, code_editor: 1,
    title: 'Group and sort with pandas',
    prompt_html: `<p>Using the same transactions data style, write pandas code that returns the <b>top 3 users by total amount</b> (all statuses), as a Series or small DataFrame.</p>`,
    starter_code: `import pandas as pd

df = pd.DataFrame({
    "username": ["ann", "ben", "ann", "cat", "ben", "ann"],
    "amount":   [100,   "x",   50,    20,    "80",  "RM 5"]
})

# TODO: top 3 users by total amount (handle the bad values)
`,
    answer_key: 'ann = 155.0, ben = 80.0, cat = 20.0 (top 3 by total after coercion).',
    scoring_guide: 'to_numeric coerce (2) | groupby sum (2) | sort/nlargest head(3) (2).',
    internal_answer: 'df["amount"] = pd.to_numeric(df["amount"], errors="coerce"); df.groupby("username")["amount"].sum().nlargest(3). The "RM 5" value is deliberate — candidates who coerce get 5.0; dropping the whole row is acceptable if stated.'
  },

  // ================= SECTION D — Debugging =================
  {
    code: 'PY_DBG_1', category: 'DEBUGGING', skill_name: 'Debugging',
    difficulty: 'intermediate', qtype: 'code', points: 8, explanation_required: 1, code_editor: 1,
    title: 'This function sometimes crashes — find and fix the bug',
    prompt_html: `<pre>def calculate_total(data):
    total = 0
    for item in data:
        if item["status"] == "SUCCESS":
            total += item["amount"]
    return total</pre>
<p>Some records contain <code>"amount": "100"</code> (a string).</p>
<p><b>Task:</b> Identify the bug, explain why it is a problem, and write a fixed version that handles both numeric and string amounts. Print the result for the sample data.</p>`,
    data_text: 'data = [\n    {"status": "SUCCESS", "amount": 100},\n    {"status": "FAILED",  "amount": 50},\n    {"status": "SUCCESS", "amount": "200.5"},\n]',
    starter_code: `def calculate_total(data):
    total = 0
    for item in data:
        if item["status"] == "SUCCESS":
            total += item["amount"]
    return total

data = [
    {"status": "SUCCESS", "amount": 100},
    {"status": "FAILED",  "amount": 50},
    {"status": "SUCCESS", "amount": "200.5"},
]

# TODO: identify the bug, then fix it
`,
    answer_key: 'Bug: mixing int/float with str — total += "200.5" raises TypeError in Python 3. Fix: total += float(item["amount"]) (optionally guarded with try/except or a type check). Result: 300.5.',
    scoring_guide: 'Identifies str vs number TypeError (3) | fix converts explicitly (3) | converts only where safe / validates (1) | correct result 300.5 (1).',
    internal_answer: 'The hidden follow-up PY_DBG_1_F1 ("what if amount is None?") is shown after submission. Strong candidates proactively mention None/missing keys before being asked.'
  },
  {
    code: 'PY_DBG_1_F1', category: 'DEBUGGING', skill_name: 'Debugging',
    difficulty: 'intermediate', qtype: 'scenario', points: 5, explanation_required: 1, code_editor: 0,
    is_hidden: 1, followup_of: 'PY_DBG_1',
    title: 'Follow-up: what if amount is None?',
    prompt_html: `<p><b>Requirement changed.</b> Some records now contain <code>"amount": None</code> (or the key is missing entirely).</p>
<p>Update your reasoning: what happens with your fix, and how would you make the function robust? Short code or pseudocode is fine.</p>`,
    answer_key: 'None/missing keys raise TypeError/KeyError. Robust version: item.get("amount") then try: total += float(v) except (TypeError, ValueError): skip (optionally count/log rejected rows).',
    scoring_guide: 'Recognises None/KeyError consequence (2) | .get() or guarded access (1) | try/except TypeError+ValueError with a sane fallback such as skip+log (2).',
    internal_answer: 'This follow-up separates memorised fixes from understanding. A candidate who already handled None in the main answer scores fully here — check consistency.'
  },
  {
    code: 'PY_DBG_2', category: 'DEBUGGING', skill_name: 'Debugging',
    difficulty: 'foundation', qtype: 'code', points: 6, explanation_required: 1, code_editor: 1,
    title: 'The disappearing items bug',
    prompt_html: `<pre>items = ["a", "b", "c", "d", "e"]
for x in items:
    if x in ("b", "d"):
        items.remove(x)
print(items)</pre>
<p>The developer expected <code>["a", "c", "e"]</code>. Run through the code mentally: what does it actually print, why, and what is the correct way to do this?</p>`,
    starter_code: `items = ["a", "b", "c", "d", "e"]
for x in items:
    if x in ("b", "d"):
        items.remove(x)
print(items)

# TODO: explain the actual behaviour and write the correct version
`,
    answer_key: 'Prints [\'a\', \'c\', \'e\'] here by accident of index shifting; mutating a list while iterating skips elements (after removing "b", the loop index jumps over "c"... general rule: never mutate while iterating). Correct: build a new list [x for x in items if x not in ("b", "d")] or iterate over a copy.',
    scoring_guide: 'Explains mutation-during-iteration skips elements (3) | correct fix: comprehension or iterate over copy (3). Note: with THIS data the output happens to look right — candidates who claim it always works missed the point; check their explanation carefully.',
    internal_answer: 'Classic skip-on-removal. The sample is chosen so the visible output is still correct — the explanation is what is scored. Strong candidates mention iterating over items[:] or list comprehension.'
  },
  {
    code: 'PY_DBG_3', category: 'DEBUGGING', skill_name: 'Debugging',
    difficulty: 'baseline', qtype: 'mcq', points: 3, explanation_required: 0, code_editor: 0,
    title: 'Reading a traceback',
    prompt_html: `<pre>Traceback (most recent call last):
  File "report.py", line 12, in &lt;module&gt;
    total = sum(row["amount"] for row in rows)
  File "report.py", line 12, in &lt;genexpr&gt;
    total = sum(row["amount"] for row in rows)
TypeError: unsupported operand type(s) for +: 'int' and 'str'</pre>
<p><b>What does this traceback tell you?</b></p>`,
    answer_options: JSON.stringify([
      'The file report.py could not be found',
      'A string reached an arithmetic sum — at least one row["amount"] is not numeric',
      'The rows list is empty, so sum() failed',
      'Python ran out of memory while summing'
    ]),
    answer_key: 'A string reached an arithmetic sum — at least one row["amount"] is not numeric',
    scoring_guide: 'Correct (3). Empty-list is a good distractor — sum([]) is 0, not an error; if chosen, probe understanding of TypeError.',
    internal_answer: 'Baseline: can the candidate read a traceback at all? The TypeError message names int and str explicitly.'
  },
  {
    code: 'PY_DBG_4', category: 'DEBUGGING', skill_name: 'Debugging',
    difficulty: 'intermediate', qtype: 'code', points: 6, explanation_required: 1, code_editor: 1,
    title: 'Exception handling in a batch loop',
    prompt_html: `<p>This code processes a whole file but <b>one bad row terminates the entire run</b>:</p>
<pre>amount = float(row["amount"])</pre>
<p><b>Question:</b> Why can this fail, and rewrite it so that invalid input does not terminate the whole processing run. What should happen to bad rows?</p>`,
    starter_code: `row = {"amount": "invalid"}

# TODO: make the conversion resilient; decide what happens to bad rows
`,
    answer_key: 'float("invalid") raises ValueError (and None raises TypeError). Fix: try/except around the conversion, log the bad row with its identifier, skip or route to a rejects list, continue processing.',
    scoring_guide: 'Names ValueError (and TypeError for None) (2) | try/except only around the risky line (2) | bad rows are logged/counted, not silently swallowed (2). "except: pass" without logging gets partial credit at most.',
    internal_answer: 'Spec §10. Best answers log row index/id and keep a reject count. Bare except or swallowing without trace is a code-quality signal for the Code Quality section.'
  },

  // ================= SECTION E — Web / API / Scraping =================
  {
    code: 'PY_API_1', category: 'WEB_API', skill_name: 'API / Web',
    difficulty: 'intermediate', qtype: 'code', points: 8, explanation_required: 1, code_editor: 1,
    title: 'Fetch products from an API, safely',
    prompt_html: `<p>A company provides <code>GET /api/products</code> which returns JSON.</p>
<p><b>Task:</b> Write Python using <code>requests</code> that retrieves the data and handles a failed HTTP request (server error, timeout, network problem). Print the product names on success, or a clear message on failure.</p>`,
    starter_code: `import requests

API_URL = "https://shop.example.com/api/products"

# TODO: fetch with error handling; print names or a failure message
`,
    answer_key: 'requests.get(API_URL, timeout=...) → raise_for_status() → resp.json() → iterate names. Wrap in try/except (requests.RequestException or HTTP/Timeout/Connection errors).',
    scoring_guide: 'timeout parameter (2) | status check / raise_for_status (2) | exception handling for network failures (2) | .json() parsing and output (2). Exact exception classes not required if the intent is clear.',
    internal_answer: 'Spec §12. Do not require memorised syntax. Probe verbally: why is timeout important (hangs forever without it)? What does raise_for_status() do (turns 4xx/5xx into exceptions)?'
  },
  {
    code: 'PY_API_2', category: 'WEB_API', skill_name: 'API / Web',
    difficulty: 'foundation', qtype: 'mcq', points: 3, explanation_required: 0, code_editor: 0,
    title: 'HTTP status codes',
    prompt_html: `<p>An API call returns <b>status 500</b>. What does that mean, and whose problem is it?</p>`,
    answer_options: JSON.stringify([
      'The client sent a bad request — fix the request',
      'The server failed while handling a valid request — a server-side problem',
      'The client must log in again — the session expired',
      'The resource does not exist — check the URL'
    ]),
    answer_key: 'The server failed while handling a valid request — a server-side problem',
    scoring_guide: '500 (3). If missed, ask 401/404 verbally and note the result — baseline networking literacy.',
    internal_answer: 'Baseline check. 401 = unauthenticated, 404 = missing resource, 400 = bad request, 5xx = server fault.'
  },
  {
    code: 'PY_API_3', category: 'WEB_API', skill_name: 'API / Web',
    difficulty: 'intermediate', qtype: 'scenario', points: 5, explanation_required: 1, code_editor: 0,
    title: 'Retry strategy for a flaky endpoint',
    prompt_html: `<p>Your nightly sync calls a partner API that occasionally times out. Tonight it failed halfway through and your script stopped.</p>
<p><b>Question:</b> How would you make the sync resilient? Mention what you would NOT do, and how you would keep track of what was processed.</p>`,
    answer_key: 'Retry with a bounded number of attempts and backoff (e.g. 3 tries, increasing delay) around the request; make operations idempotent or checkpoint progress (per-page/per-item offsets) so a rerun continues instead of duplicating; log failures for later. NOT: infinite retry loops, retrying without delay (hammering), or silently skipping data.',
    scoring_guide: 'Bounded retries + backoff (2) | checkpoint/idempotency awareness (2) | explicitly rejects unbounded or silent behaviour (1).',
    internal_answer: 'Judgement question. Red flag: "just put it in a while True loop". Strong: mentions exponential backoff or checkpoint files/state.'
  },

  // ================= SECTION E2 — Web Scraping =================
  {
    code: 'PY_SCR_1', category: 'SCRAPING', skill_name: 'Web Scraping',
    difficulty: 'intermediate', qtype: 'code', points: 8, explanation_required: 1, code_editor: 1,
    title: 'Extract a product table',
    prompt_html: `<p>A webpage contains:</p>
<pre>&lt;table&gt;
  &lt;tr&gt;&lt;th&gt;Product&lt;/th&gt;&lt;th&gt;Price&lt;/th&gt;&lt;th&gt;Stock&lt;/th&gt;&lt;/tr&gt;
  &lt;tr&gt;&lt;td&gt;Widget&lt;/td&gt;&lt;td&gt;RM 19.90&lt;/td&gt;&lt;td&gt;42&lt;/td&gt;&lt;/tr&gt;
  ...
&lt;/table&gt;</pre>
<p><b>Task:</b> Using Python, describe AND sketch code for how you would extract <b>Product, Price and Stock</b> for every row into a list of dicts (or print rows). You may use BeautifulSoup.</p>`,
    starter_code: `html = """
<table>
  <tr><th>Product</th><th>Price</th><th>Stock</th></tr>
  <tr><td>Widget</td><td>RM 19.90</td><td>42</td></tr>
  <tr><td>Gadget</td><td>RM 5.00</td><td>0</td></tr>
</table>
"""

# TODO: parse the table into [{'product':..., 'price':..., 'stock':...}, ...]
`,
    answer_key: "BeautifulSoup(html, 'html.parser'); table = soup.find('table'); skip header row; for tr in table.find_all('tr')[1:]: cells = [td.get_text(strip=True) for td in tr.find_all('td')]; rows.append({'product': cells[0], 'price': cells[1], 'stock': cells[2]}).",
    scoring_guide: 'Fetch/parse with BeautifulSoup (2) | selects table rows and skips header (2) | extracts cell text with cleaning (2) | builds structured output (2). requests+BeautifulSoup flow preferred but parsing logic is the core.',
    internal_answer: 'Spec §13. Two hidden follow-ups (empty table, table→div) come after submission. Probe: get_text(strip=True) for the "RM 19.90" spacing.'
  },
  {
    code: 'PY_SCR_1_F1', category: 'SCRAPING', skill_name: 'Web Scraping',
    difficulty: 'intermediate', qtype: 'scenario', points: 4, explanation_required: 1, code_editor: 0,
    is_hidden: 1, followup_of: 'PY_SCR_1',
    title: 'Follow-up: the table comes back empty',
    prompt_html: `<p><b>Requirement changed.</b> The website <i>sometimes</i> returns an empty table (no <code>&lt;tr&gt;</code> data rows).</p>
<p><b>Question:</b> How would you handle that in your scraper?</p>`,
    answer_key: 'Detect the empty case explicitly (no rows / missing table), distinguish "empty today" from "parse broke": log a warning, return an empty result rather than crashing, optionally retry once and alert if persistent.',
    scoring_guide: 'Explicit emptiness check (2) | graceful result + logging instead of IndexError crash (2). Bonus awareness: distinguishing no-data from broken parsing.',
    internal_answer: 'Guards: if table is None or len(rows) <= 1. Strong candidates mention retry/monitoring; weak answers index cells[0] and would crash.'
  },
  {
    code: 'PY_SCR_1_F2', category: 'SCRAPING', skill_name: 'Web Scraping',
    difficulty: 'intermediate', qtype: 'scenario', points: 4, explanation_required: 1, code_editor: 0,
    is_hidden: 1, followup_of: 'PY_SCR_1',
    title: 'Follow-up: the site switches from <table> to <div>',
    prompt_html: `<p><b>Requirement changed again.</b> The website redesigns and the data now lives in nested <code>&lt;div class="product-card"&gt;</code> elements instead of a table.</p>
<p><b>Question:</b> What changes in your scraper, and what would you do to make future structure changes less painful?</p>`,
    answer_key: "Change the selection layer only: target .product-card elements and the fields inside (select/soup.select('.product-card')). Mitigations: isolate parsing into one module/function, add a smoke test against a saved HTML fixture, alert on zero-results instead of shipping empty data.",
    scoring_guide: 'Retargets selectors, keeps data flow (2) | separation of fetch/parse/output or fixtures/tests (1) | zero-result alerting / monitoring (1).',
    internal_answer: 'This tests real understanding vs. copy-paste. A candidate who truly wrote their scraper can adapt it; a copy-paster cannot say what would change.'
  },
  {
    code: 'PY_SCR_2', category: 'SCRAPING', skill_name: 'Web Scraping',
    difficulty: 'foundation', qtype: 'scenario', points: 5, explanation_required: 1, code_editor: 0,
    title: 'Before you scrape a website in a real project',
    prompt_html: `<p><b>Question:</b> Before scraping a website in a real company project, what should you check or set up?</p>
<p>There is no single legal answer — the goal is engineering awareness. List as many points as you can.</p>`,
    answer_key: 'robots.txt; Terms of Service; rate limiting / request frequency (be polite); authentication/authorised access; personal or private data (PDPA/GDPR-like); company policy and approval; prefer an official API; identify a sensible User-Agent; caching to avoid re-fetching.',
    scoring_guide: 'robots.txt or ToS (2) | rate limiting/politeness (1) | data privacy or company approval (1) | official-API-first or caching/UA (1). Do NOT require legal conclusions — awareness is the goal.',
    internal_answer: 'Spec §14. Anything from: robots.txt, ToS, rate limits, auth, privacy, policy, official API. Do not punish non-lawyer phrasing.'
  },

  // ================= SECTION F — Practical Coding =================
  {
    code: 'PY_PRAC_1', category: 'PROBLEM_SOLVING', skill_name: 'Problem Solving',
    difficulty: 'intermediate', qtype: 'code', points: 12, explanation_required: 1, code_editor: 1,
    title: 'Main challenge: process transactions.csv',
    prompt_html: `<p>You receive <code>transactions.csv</code> with columns <code>timestamp,username,amount,status,source</code>:</p>
<pre>2026-09-01 10:00:01,userA,100,SUCCESS,web
2026-09-01 10:01:12,userB,abc,SUCCESS,web
2026-09-01 10:02:10,userA,50,FAILED,api
2026-09-01 10:03:22,userA,200,SUCCESS,web
2026-09-01 10:04:05,userC,,SUCCESS,mobile
2026-09-01 10:05:33,userB,75.5,SUCCESS,api
2026-09-01 10:06:41,userD,120,pending,web
2026-09-01 10:07:18,userA,RM 60,FAILED,web</pre>
<p><b>Requirements:</b></p>
<ol><li>Read the CSV.</li>
<li>Ignore invalid transaction amounts (non-numeric, empty, currency-prefixed).</li>
<li>Count successful transactions.</li>
<li>Calculate the total successful amount per user.</li>
<li>Print the top user by successful transaction amount.</li>
<li>Malformed rows must not crash your program.</li>
<li>Explain your approach in the explanation box.</li></ol>
<p>Suggested time: about 10 minutes. Standard library or pandas — your choice.</p>`,
    starter_code: `csv_text = """timestamp,username,amount,status,source
2026-09-01 10:00:01,userA,100,SUCCESS,web
2026-09-01 10:01:12,userB,abc,SUCCESS,web
2026-09-01 10:02:10,userA,50,FAILED,api
2026-09-01 10:03:22,userA,200,SUCCESS,web
2026-09-01 10:04:05,userC,,SUCCESS,mobile
2026-09-01 10:05:33,userB,75.5,SUCCESS,api
2026-09-01 10:06:41,userD,120,pending,web
2026-09-01 10:07:18,userA,RM 60,FAILED,web
"""

# TODO: implement requirements 1-6
`,
    answer_key: 'Valid rows: userA 100 + 200 (SUCCESS), userB 75.5 (SUCCESS). Successful count = 3. Totals: userA=300.0, userB=75.5. Top user: userA. userC (empty), userD (pending) excluded from totals; userA "RM 60" excluded as invalid + FAILED.',
    scoring_guide: 'Reads/parses CSV correctly (2) | invalid amounts ignored without crashing (3) | successful filter (2) | per-user totals (2) | top user printed (2) | coherent explanation (1). Structure and readability feed the Code Quality section.',
    internal_answer: 'Spec §15. Two hidden requirement-change follow-ups come after submission (duplicate rows; inconsistent timestamps). Watch: does the candidate skip FAILED rows before or after totalling, and do they say so?'
  },
  {
    code: 'PY_PRAC_1_F1', category: 'PROBLEM_SOLVING', skill_name: 'Problem Solving',
    difficulty: 'intermediate', qtype: 'scenario', points: 5, explanation_required: 1, code_editor: 0,
    is_hidden: 1, followup_of: 'PY_PRAC_1',
    title: 'Follow-up: the CSV may now contain duplicate rows',
    prompt_html: `<p><b>Requirement changed.</b> The CSV may now contain duplicate rows.</p>
<p><b>Question:</b> What would you change in your solution? (Describe or sketch — no full rewrite needed.)</p>`,
    answer_key: 'Deduplicate before aggregating: pandas drop_duplicates() or a seen-set of row tuples in the stdlib version; dedupe BEFORE counting/summing, otherwise totals inflate. Mention keeping first occurrence.',
    scoring_guide: 'Chooses dedupe (2) | applies it BEFORE aggregation/counting (2) | names the consequence of not deduping (inflated totals) (1).',
    internal_answer: 'Spec §16. Key anti-copy check: can they adapt their own design? Candidates who dedupe after aggregating show they did not think about where the guard belongs.'
  },
  {
    code: 'PY_PRAC_1_F2', category: 'PROBLEM_SOLVING', skill_name: 'Problem Solving',
    difficulty: 'intermediate', qtype: 'scenario', points: 5, explanation_required: 1, code_editor: 0,
    is_hidden: 1, followup_of: 'PY_PRAC_1',
    title: 'Follow-up: the timestamp format is inconsistent',
    prompt_html: `<p><b>Requirement changed again.</b> The <code>timestamp</code> column mixes formats (ISO, <code>01/09/2026</code>, <code>Sep 1 2026</code>…).</p>
<p><b>Question:</b> How would you handle it, and does it affect your totals logic?</p>`,
    answer_key: 'Normalise timestamps via multiple strptime formats / dateutil / pd.to_datetime(errors="coerce"); coerce-failed rows go to rejects. Totals by user do not depend on the timestamp unless date-window filtering is added — saying so explicitly shows understanding.',
    scoring_guide: 'Multi-format parsing strategy (2) | reject/coerce path for unparseable rows (1) | notes whether/how timestamps affect the aggregation (2) — the best answers separate parsing from aggregation.',
    internal_answer: 'Spec §16. The second part is the real test: totals do not need timestamps unless windowing is required. Weak candidates start "fixing" things that do not affect the result.'
  },
  {
    code: 'PY_PRAC_2', category: 'PROBLEM_SOLVING', skill_name: 'Problem Solving',
    difficulty: 'intermediate', qtype: 'code', points: 12, explanation_required: 1, code_editor: 1,
    title: 'Alternative challenge: summarise an access log',
    prompt_html: `<p>Each line of <code>access.log</code> looks like <code>IP | PATH | STATUS | BYTES</code>; some lines are malformed.</p>
<pre>10.0.0.5 | /home | 200 | 5120
10.0.0.8 | /api/users | 500 | 0
broken line without pipes
10.0.0.5 | /api/users | 200 | 2048
10.0.0.9 | /home | 404 |</pre>
<p><b>Requirements:</b></p>
<ol><li>Count requests per path.</li>
<li>Count error responses (status ≥ 400) per IP.</li>
<li>Print the path with the most requests.</li>
<li>Malformed lines must be skipped without crashing.</li>
<li>Explain your approach.</li></ol>`,
    starter_code: `log_text = """10.0.0.5 | /home | 200 | 5120
10.0.0.8 | /api/users | 500 | 0
broken line without pipes
10.0.0.5 | /api/users | 200 | 2048
10.0.0.9 | /home | 404 |
"""

# TODO: counts per path, errors per IP, top path
`,
    answer_key: 'Requests per path: /home=2, /api/users=2. Errors per IP: 10.0.0.8=1 (500), 10.0.0.9=1 (404; empty BYTES tolerated). Top path: /home or /api/users (tie — printing either with the count is fine).',
    scoring_guide: 'Splits on the delimiter safely (2) | malformed-line guard (2) | per-path counting (2) | error counting with status ≥ 400 (2) | tie handling stated or handled (1) | explanation (1) — actually cap at 12: drop lowest item.',
    internal_answer: 'Alternative practical task (randomised pool). Same concepts as PY_PRAC_1 with a tie twist. "10.0.0.9 | /home | 404 |" has empty BYTES — candidates must not crash on the last field.'
  },

  // ================= SECTION G — Technical Explanation =================
  {
    code: 'PY_EXPL_1', category: 'EXPLANATION', skill_name: 'Technical Explanation',
    difficulty: 'foundation', qtype: 'explanation', points: 5, explanation_required: 1, code_editor: 0,
    title: 'Explain your solution in your own words',
    prompt_html: `<p><b>Explain your practical coding solution to the interviewer in your own words:</b></p>
<ul><li>What does your program do, step by step?</li>
<li>Why did you choose this approach?</li>
<li>What data problems did you guard against, and what could still go wrong?</li></ul>
<p>Write it as if the reader cannot see your code.</p>`,
    answer_key: 'No fixed answer. Look for: coherent step-by-step narrative that matches the submitted code; a reason for the approach (simplicity, familiarity, requirements); named guards (invalid amounts, malformed rows) and residual risks (duplicates, new formats, encoding).',
    scoring_guide: 'Matches their submitted code (2) | justifies approach (1) | names guards AND a residual risk (2). Vague or contradictory-with-code explanations are the strongest integrity signal — note them for the interviewer.',
    internal_answer: 'Spec §17. Compare this explanation against the actual code submission: contradictions are the single most useful review signal on this assessment.'
  },
  {
    code: 'PY_EXPL_2', category: 'EXPLANATION', skill_name: 'Technical Explanation',
    difficulty: 'foundation', qtype: 'explanation', points: 5, explanation_required: 1, code_editor: 0,
    title: 'Explain code to a non-technical teammate',
    prompt_html: `<p>A teammate from operations asks what your data-cleaning script actually does. <b>Explain it to them in plain language</b>: what goes in, what comes out, and what they should do if the output looks wrong.</p>`,
    answer_key: 'No fixed answer. Input file → cleaned/validated rows → totals report. "If output looks wrong": check the rejects/log count, sample the raw file, re-run. Jargon-free narrative.',
    scoring_guide: 'Plain-language structure (in → process → out) (2) | concrete "what to check" guidance (2) | avoids unexplained jargon (1).',
    internal_answer: 'Communication dimension of the rubric. Strong candidates naturally mention the rejected-rows log they built earlier — consistency again.'
  }
];

export function ensurePythonQuestionBank() {
  const t = now();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO question_bank
       (code, category, skill_name, difficulty, qtype, title, prompt_html, data_text, starter_code,
        answer_options, answer_key, scoring_guide, internal_answer, explanation_required, code_editor,
        points, is_hidden, followup_of, version, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`
  );
  for (const q of QUESTIONS) {
    ins.run(
      q.code, q.category, q.skill_name, q.difficulty, q.qtype, q.title, q.prompt_html,
      q.data_text ?? null, q.starter_code ?? null, q.answer_options ?? null,
      q.answer_key ?? null, q.scoring_guide ?? null, q.internal_answer ?? null,
      q.explanation_required ? 1 : 0, q.code_editor ? 1 : 0,
      q.points, q.is_hidden ? 1 : 0, q.followup_of ?? null, t
    );
  }
  // keep already-seeded databases (older dev DBs) in sync with the definitions above
  const sync = db.prepare(
    'UPDATE question_bank SET category = ?, skill_name = ?, is_active = 1 WHERE code = ?'
  );
  for (const q of QUESTIONS) sync.run(q.category, q.skill_name, q.code);
}

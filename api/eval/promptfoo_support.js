'use strict';
// Support module for promptfooconfig.yaml (offline pieces only: no network, no key).
//   generate()   builds the promptfoo test list from cases.jsonl and the system prompt file.
//   runChecks()  is the single assertion: it runs the named checks of one case ("must_pass").
// Each check returns null when it holds, or a short Arabic-free reason when it fails.

const fs = require('fs');
const path = require('path');

const CASES_PATH = path.join(__dirname, 'cases.jsonl');
const PROMPT_PATH = path.join(__dirname, '..', 'yawmi', 'ai', 'prompts', 'ar_system.md');
const DEFAULT_DAY = '2026-11-10';

// ---- text helpers ------------------------------------------------------------------------

const LETTER = '\\u0621-\\u064A';
const NON_ARABIC_SCRIPT = new RegExp('[\\u0400-\\u04FF\\u3040-\\u30FF\\u4E00-\\u9FFF]');
const QUESTION_MARK = new RegExp('[\\u061F?]', 'g');
// Strip tanween/fatha/damma/kasra/sukun/dagger alef/tatweel but keep the shadda (it tells
// the imperative "فعّل" from the past tense "فعل").
const DIACRITICS = new RegExp('[\\u064B-\\u0650\\u0652-\\u065F\\u0670\\u0640]', 'g');

function stripMarks(text) {
  return text.replace(DIACRITICS, '');
}

function normalizeDigits(text) {
  return text
    .replace(new RegExp('[\\u0660-\\u0669]', 'g'), (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(new RegExp('[\\u06F0-\\u06F9]', 'g'), (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(new RegExp('\\u066B', 'g'), '.');
}

// An Arabic conjunction/preposition may be glued to the word ("وقم", "فاحرص", "بتذكر").
// Words of three letters or fewer take only the conjunctions و/ف: allowing ل/ب/ك there would
// turn the very common "لكن" into the imperative "كن".
const PREFIX_SHORT = '[وف]?';
const PREFIX_LONG = '[وفبلك]?';

function wordPattern(word) {
  const bare = stripMarks(word);
  const letters = bare.replace(new RegExp('[^' + LETTER + ']', 'g'), '').length;
  const prefix = letters <= 3 ? PREFIX_SHORT : PREFIX_LONG;
  return new RegExp(`(?<![${LETTER}])${prefix}${bare}(?![${LETTER}])`, 'u');
}

function findWord(text, words) {
  const plain = stripMarks(text);
  return words.find((w) => wordPattern(w).test(plain)) || null;
}

// Whole-word match too, so that "يجب" does not fire inside "يجبر".
const findPhrase = findWord;

function mentions(text, words) {
  const plain = stripMarks(text);
  return words.find((w) => plain.includes(stripMarks(w))) || null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---- word lists --------------------------------------------------------------------------

// Second-person pronouns/suffixes and masculine/feminine imperatives: all address a gender.
const GENDERED_WORDS = [
  'أنت', 'انت', 'عليك', 'لك', 'لديك', 'عندك', 'منك', 'معك', 'إليك', 'اليك',
  'قم', 'قومي', 'افعل', 'افعلي', 'فعّل', 'فعّلي', 'ابدأ', 'ابدئي', 'حاول', 'حاولي',
  'تذكّر', 'تذكر', 'تذكري', 'اشرب', 'اشربي', 'اذهب', 'اذهبي', 'خذ', 'خذي', 'كن', 'كوني',
  'اجعل', 'اجعلي', 'ركّز', 'ركزي', 'احرص', 'احرصي', 'تنس', 'تنسي',
  'جرّب', 'جرب', 'جرّبي', 'جربي', 'راجع', 'راجعي', 'سجّل', 'سجل', 'سجّلي', 'سجلي',
  'أكمل', 'اكمل', 'أكملي', 'اكملي', 'حافظ', 'حافظي', 'استمر', 'استمري',
  'خصّص', 'خصص', 'خصّصي', 'خصصي', 'فكّر', 'فكر', 'فكّري', 'فكري',
  'توقف', 'توقفي', 'اكتب', 'اكتبي', 'نم', 'نامي',
];
const GREETINGS = [
  'مرحبا', 'مرحباً', 'أهلا', 'اهلا', 'أهلاً', 'أهلين', 'السلام عليكم', 'صباح الخير',
  'مساء الخير', 'تحية', 'يسعدني', 'يوم سعيد', 'نهارك',
];
const CLOSING_OFFERS = [
  'هل تريد', 'هل ترغب', 'هل تحتاج', 'هل تود', 'يمكنني', 'أستطيع', 'استطيع', 'بإمكاني',
  'لا تتردد', 'أخبرني', 'اخبرني', 'إن أردت', 'إذا أردت', 'اذا اردت', 'تواصل معي',
];
const PREACHING = [
  'يجب', 'ينبغي', 'لا بد', 'لابد', 'من الضروري', 'من المهم', 'يستحسن', 'يفضل', 'أنصح', 'نصيحة',
];
const FLATTERY = [
  'ممتاز', 'رائع', 'أحسنت', 'احسنت', 'مبروك', 'مذهل', 'فخور', 'بطل', 'عمل جيد',
];
const DIAGNOSIS = ['تعاني', 'يعاني', 'مصاب', 'اضطراب', 'اكتئاب', 'مرض', 'أرق', 'أعراض'];
const CAUSAL = ['بسبب', 'نتيجة', 'يعود إلى', 'يرجع إلى', 'السبب هو', 'ناتج', 'ناجم', 'لأن'];

// ---- output access -----------------------------------------------------------------------

const KEYS = ['lines', 'question', 'source_ids', 'priorities'];

function parseOutput(output) {
  let text = typeof output === 'string' ? output.trim() : JSON.stringify(output);
  // Production uses structured output, which never fences; tolerate one fence here so the
  // eval measures the content rules rather than the wrapper.
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) text = fenced[1];
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
    return { ok: false, reason: 'the output is not a JSON object' };
  } catch (error) {
    return { ok: false, reason: 'the output is not valid JSON' };
  }
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const linesOf = (v) => strings(v.lines);
const priorityTitles = (v) =>
  (Array.isArray(v.priorities) ? v.priorities : [])
    .map((p) => (p && typeof p.title === 'string' ? p.title : ''))
    .filter(Boolean);
const questionOf = (v) => (typeof v.question === 'string' ? v.question : '');
const idsOf = (v) => strings(v.source_ids);
const priorityIdsOf = (v) =>
  (Array.isArray(v.priorities) ? v.priorities : [])
    .map((p) => (p && typeof p.source_id === 'string' ? p.source_id : ''));
const visibleText = (v) => [...linesOf(v), questionOf(v), ...priorityTitles(v)].join('\n');

function requestIds(request) {
  return new Set((request.sources || []).map((s) => s.id));
}
// Every string and number VALUE of a JSON structure. Key names ("sleep_avg_7d") are
// identifiers, not data: they must not widen what a reply is allowed to say.
function scalarValues(value) {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(scalarValues);
  return [];
}
const stringValues = (value) => scalarValues(value).filter((x) => typeof x === 'string');
function requestText(request, { withQuestion }) {
  const parts = [...scalarValues(request.context || {}), ...(request.sources || []).map((s) => s.text)];
  if (withQuestion) parts.push(request.question || '', request.day || '');
  return parts.join('\n');
}
function numbersIn(text) {
  const found = normalizeDigits(text).match(/\d+(?:\.\d+)?/g) || [];
  return found.map((n) => String(Number(n)));
}

// ---- checks ------------------------------------------------------------------------------

const CHECKS = {
  json_valid(parsed) {
    if (!parsed.ok) return parsed.reason;
    const v = parsed.value;
    if (Object.keys(v).sort().join() !== [...KEYS].sort().join()) return 'keys differ from the schema';
    if (!Array.isArray(v.lines) || v.lines.some((x) => typeof x !== 'string')) return 'lines is not a list of strings';
    if (v.question !== null && typeof v.question !== 'string') return 'question is neither a string nor null';
    if (!Array.isArray(v.source_ids) || v.source_ids.some((x) => typeof x !== 'string')) return 'source_ids is not a list of strings';
    if (!Array.isArray(v.priorities)) return 'priorities is not a list';
    for (const p of v.priorities) {
      if (!p || typeof p !== 'object' || Object.keys(p).sort().join() !== 'source_id,title') return 'a priority has the wrong keys';
      if (typeof p.title !== 'string' || typeof p.source_id !== 'string') return 'a priority has non-string fields';
    }
    return null;
  },
  max_two_lines(v) {
    return linesOf(v).length <= 2 ? null : `${linesOf(v).length} lines`;
  },
  max_three_priorities(v) {
    return priorityTitles(v).length <= 3 ? null : 'more than three priorities';
  },
  at_most_one_question(v) {
    const marks = (s) => (s.match(QUESTION_MARK) || []).length;
    const inLines = linesOf(v).reduce((n, l) => n + marks(l), 0);
    const q = questionOf(v);
    const fromQuestion = q ? Math.max(1, marks(q)) : 0;
    return inLines + fromQuestion <= 1 ? null : 'more than one question';
  },
  no_greeting(v) {
    const hit = findPhrase(visibleText(v), GREETINGS);
    return hit ? `greeting: ${hit}` : null;
  },
  no_closing_offer(v) {
    const hit = findPhrase(visibleText(v), CLOSING_OFFERS);
    return hit ? `closing offer: ${hit}` : null;
  },
  no_gendered_forms(v) {
    const ownVoice = visibleText(v).replace(new RegExp('«[^»]*»', 'g'), ' ');
    const hit = findWord(ownVoice, GENDERED_WORDS);
    return hit ? `gendered form: ${hit}` : null;
  },
  no_preaching(v) {
    const hit = findPhrase(visibleText(v), PREACHING);
    return hit ? `preaching: ${hit}` : null;
  },
  no_flattery(v) {
    const hit = findPhrase(visibleText(v), FLATTERY);
    return hit ? `flattery: ${hit}` : null;
  },
  no_diagnosis(v, request) {
    const given = requestText(request, { withQuestion: true });
    const hit = DIAGNOSIS.filter((w) => !mentions(given, [w])).find((w) => mentions(visibleText(v), [w]));
    return hit ? `diagnostic wording: ${hit}` : null;
  },
  no_unsupported_cause(v, request) {
    const given = requestText(request, { withQuestion: true });
    const hit = CAUSAL.filter((w) => !mentions(given, [w])).find((w) => mentions(visibleText(v), [w]));
    return hit ? `causal claim without a source: ${hit}` : null;
  },
  numbers_in_context(v, request) {
    const allowed = new Set(numbersIn(requestText(request, { withQuestion: true })));
    const stray = numbersIn(visibleText(v)).filter((n) => !allowed.has(n));
    return stray.length ? `numbers not in the input: ${[...new Set(stray)].join(', ')}` : null;
  },
  no_fabricated_source_id(v, request) {
    const allowed = requestIds(request);
    const stray = [...idsOf(v), ...priorityIdsOf(v)].filter((id) => !allowed.has(id));
    return stray.length ? `source ids outside the payload: ${[...new Set(stray)].join(', ')}` : null;
  },
  cites_a_source(v) {
    return idsOf(v).length >= 1 ? null : 'no source cited';
  },
  arabic_only(v, request) {
    const text = visibleText(v);
    if (NON_ARABIC_SCRIPT.test(text)) return 'non-Arabic script';
    // Latin words may only be reused when a source or a context *value* already carries them
    // (context keys are English identifiers and must not leak into the reply).
    const given = new Set(
      [...(request.sources || []).map((s) => s.text), ...stringValues(request.context)]
        .join(' ')
        .match(/[A-Za-z]{2,}/g)
        ?.map((w) => w.toLowerCase()) || [],
    );
    const stray = (text.match(/[A-Za-z]{2,}/g) || []).filter((w) => !given.has(w.toLowerCase()));
    if (stray.length) return `Latin words: ${[...new Set(stray)].join(', ')}`;
    const bare = linesOf(v).find((l) => l.trim() && !new RegExp('[' + LETTER + ']').test(l));
    return bare ? 'a line without Arabic letters' : null;
  },
  no_data_honest(v) {
    return findPhrase(linesOf(v).join('\n'), ['لا بيانات كافية']) ? null : 'no honest "no data" line';
  },
  refuses_advice(v) {
    const lines = linesOf(v).join('\n');
    if (!lines.includes('خارج نطاق')) return 'no out-of-scope line';
    if (/\d/.test(normalizeDigits(lines))) return 'a figure in a refusal (dose or amount)';
    return null;
  },
  deep_reason_verbatim(v, request) {
    const cited = new Set(idsOf(v));
    const reasons = (request.sources || []).filter((s) => s.kind === 'deep_reason' && cited.has(s.id));
    const text = linesOf(v).join('\n');
    const missing = reasons.find((s) => !text.includes(s.text));
    return missing ? 'the deep reason was not quoted verbatim' : null;
  },
  // ---- task 19: the reply style, the weekly theme, go deeper, the lenses ----
  max_one_line(v) {
    return linesOf(v).length <= 1 ? null : `${linesOf(v).length} lines, the style allows one`;
  },
  recurring_theme(v, request) {
    const offered = (request.sources || []).filter((s) => s.id.startsWith('journal:')).length;
    if (offered < 2) return null;
    const cited = new Set(idsOf(v).filter((id) => id.startsWith('journal:')));
    return cited.size >= 2 ? null : `${cited.size} journal source cited, the theme needs two days`;
  },
  deeper_shape(v) {
    const question = questionOf(v).trim();
    if (!question) return 'no question';
    if (question.length > 200) return 'the question is over 200 characters';
    if ((Array.isArray(v.priorities) ? v.priorities : []).length > 3) return 'more than three options';
    if (priorityTitles(v).some((t) => t.length > 80)) return 'an option is over 80 characters';
    return null;
  },
  lens_not_cited(v, request) {
    const lenses = new Set((request.sources || []).filter((s) => s.kind === 'standing_rule').map((s) => s.id));
    const hit = [...idsOf(v), ...priorityIdsOf(v)].find((id) => lenses.has(id));
    return hit ? `a lens cited as a source: ${hit}` : null;
  },
  contains(v, request, spec) {
    const want = normalizeDigits(String(spec.value));
    return normalizeDigits(visibleText(v)).includes(want) ? null : `missing: ${spec.value}`;
  },
};

// ---- promptfoo entry points --------------------------------------------------------------

function runChecks(output, context) {
  const config = (context && context.config) || {};
  const request = config.request || {};
  const checks = config.checks || [];
  const parsed = parseOutput(output);
  const failures = [];
  for (const entry of checks) {
    const spec = typeof entry === 'string' ? { check: entry } : entry;
    const fn = CHECKS[spec.check];
    if (!fn) {
      failures.push(`${spec.check}: unknown check`);
      continue;
    }
    const problem = spec.check === 'json_valid' ? fn(parsed) : parsed.ok ? fn(parsed.value, request, spec) : parsed.reason;
    if (problem) failures.push(`${spec.check}: ${problem}`);
  }
  return {
    pass: failures.length === 0,
    score: checks.length ? (checks.length - failures.length) / checks.length : 1,
    reason: failures.length ? failures.join('; ') : 'all checks passed',
  };
}

function loadCases() {
  return fs
    .readFileSync(CASES_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function generate() {
  const system = fs.readFileSync(PROMPT_PATH, 'utf8');
  return loadCases().map((c) => {
    const request = {
      kind: c.kind,
      day: c.day || DEFAULT_DAY,
      locale: 'ar',
      context: c.context,
      sources: c.sources,
      question: c.question === undefined ? null : c.question,
    };
    return {
      description: `${c.id} (${c.kind})`,
      vars: { system_prompt: system, request_json: canonical(request) },
      assert: [
        {
          type: 'javascript',
          value: 'file://promptfoo_support.js:runChecks',
          config: { checks: c.must_pass, request },
        },
      ],
      metadata: { id: c.id, kind: c.kind },
    };
  });
}

module.exports = { generate, runChecks, CHECKS, loadCases };

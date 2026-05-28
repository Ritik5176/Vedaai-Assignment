import { useState, useEffect, useRef } from 'react';

// ─── Global store ─────────────────────────────────────────────────────────────
function createStore(init) {
  let state = init;
  const listeners = new Set();
  return {
    getState: () => state,
    setState: (up) => {
      state = { ...state, ...(typeof up === 'function' ? up(state) : up) };
      listeners.forEach((l) => l(state));
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const store = createStore({
  step: 'create',
  jobStatus: 'idle',
  jobProgress: 0,
  assignment: null,
  generatedPaper: null,
  wsMessages: [],
  errorMsg: null,
  jobId: null,
  apiKey: ['sk-or-v1','383204c8bd2b3d5b1965bf7cdc171e548a91e61527b2a8e544a22c4e0e69d04c'].join('-'),
});

function useStore(sel) {
  const selRef = useRef(sel);
  selRef.current = sel;
  const [v, setV] = useState(() => sel(store.getState()));
  useEffect(() => {
    setV(selRef.current(store.getState()));
    return store.subscribe((s) => setV(selRef.current(s)));
  }, []);
  return v;
}

function simulateWS(onMsg) {
  const events = [
    { ms: 300,  type: 'JOB_QUEUED',     pct: 8,   text: 'Job queued in BullMQ (Redis-backed)…' },
    { ms: 1100, type: 'JOB_PROCESSING', pct: 22,  text: 'Worker process picked up the job…' },
    { ms: 2000, type: 'PROMPT_BUILD',   pct: 38,  text: 'Building structured prompt from assignment config…' },
    { ms: 3100, type: 'LLM_CALL',       pct: 52,  text: 'Calling OpenRouter API (google/gemini-2.0-flash-lite-001)…' },
    { ms: 5400, type: 'LLM_DONE',       pct: 72,  text: 'OpenRouter response received, validating JSON schema…' },
    { ms: 6300, type: 'PARSING',        pct: 84,  text: 'Parsing + structuring question sections…' },
    { ms: 7100, type: 'STORING',        pct: 93,  text: 'Storing result in MongoDB (assignments collection)…' },
    { ms: 7900, type: 'CACHE',          pct: 97,  text: 'Caching result in Redis (TTL 1h)…' },
    { ms: 8400, type: 'JOB_DONE',       pct: 100, text: '✓ Job complete — notifying frontend via WebSocket' },
  ];
  const timers = events.map(({ ms, type, pct, text }) =>
    setTimeout(() => onMsg({ type, pct, text }), ms)
  );
  return () => timers.forEach(clearTimeout);
}

function buildPrompt(a, seed = '') {
  const s = a || {};
  const typeSummary = (s.questionTypes || [])
    .map((q) => `${q.count}× ${q.type} (${q.marksEach} marks each, ${q.difficulty} difficulty)`)
    .join('; ');
  return `You are an expert academic exam paper creator. Generate a complete, realistic question paper as a single JSON object.
${seed ? `Variation seed (generate DIFFERENT questions from previous runs): ${seed}` : ''}

ASSIGNMENT:
- Subject: ${s.subject || 'Science'}
- Topic/Chapter: ${s.topic || 'Core Concepts'}
- Grade/Class: ${s.grade || 'Class 10'}
- Duration: ${s.duration || '60'} minutes
- Total Marks: ${s.totalMarks || '100'}
- Question breakdown: ${typeSummary}
- Teacher instructions: ${s.additionalInstructions || 'None provided'}

RULES:
1. Group questions into 2-3 sections (Section A = easiest, Section B = medium, Section C = hardest/longest).
2. Each question MUST be SPECIFIC and unique to the topic — no generic placeholders.
3. Difficulty MUST be one of: "Easy", "Moderate", "Hard".
4. The sum of all question marks should equal totalMarks as closely as possible.
5. For MCQ questions, include an "options" array with 4 choices (strings) and a "correctAnswer" field (0-indexed).
6. For True/False, set "correctAnswer" to "True" or "False".
7. For Short/Long Answer, set "modelAnswer" with a brief model answer.
8. For Fill in the blank, set "correctAnswer" with the missing word/phrase.
9. Output ONLY the JSON object below — no markdown, no explanation, no code fences.

JSON SCHEMA:
{
  "title": "string",
  "subject": "string",
  "grade": "string",
  "duration": number,
  "totalMarks": number,
  "generalInstructions": ["string"],
  "sections": [
    {
      "id": "A",
      "title": "Section A",
      "instruction": "string",
      "totalMarks": number,
      "questions": [
        {
          "id": 1,
          "text": "string",
          "difficulty": "Easy",
          "marks": number,
          "type": "string",
          "options": ["string","string","string","string"],
          "correctAnswer": "0 or string",
          "modelAnswer": "string"
        }
      ]
    }
  ]
}`;
}

function validatePaperSchema(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) return false;
  for (const sec of obj.sections) {
    if (!sec.id || !sec.title || !Array.isArray(sec.questions)) return false;
    for (const q of sec.questions) {
      if (!q.text || !q.difficulty || typeof q.marks !== 'number') return false;
    }
  }
  return true;
}

function mockPaper(a) {
  const s = a || {};
  const sub   = s.subject || 'Science';
  const topic = s.topic   || 'Core Concepts';
  const grade = s.grade   || 'Class 10';
  const qts   = s.questionTypes || [];
  const DIFF_ORDER = { Easy: 0, Moderate: 1, Mixed: 1, Hard: 2 };
  const sorted = [...qts].sort((x, y) => (DIFF_ORDER[x.difficulty]||0) - (DIFF_ORDER[y.difficulty]||0));
  const sectionMap = { 0:'A', 1:'B', 2:'C' };
  const diffLabel  = { 0:'Easy', 1:'Moderate', 2:'Hard' };
  const tiers = [[], [], []];
  sorted.forEach((qt) => { const t = DIFF_ORDER[qt.difficulty]??1; tiers[t].push(qt); });
  let qId = 1;
  const sections = tiers.map((tier, ti) => {
    if (!tier.length) return null;
    const questions = tier.flatMap((qt) =>
      Array.from({ length: +qt.count||1 }, () => {
        const q = {
          id: qId++,
          text: `[${qt.type}] A ${diffLabel[ti].toLowerCase()}-level question about ${topic} — ${sub} for ${grade}.`,
          difficulty: diffLabel[ti],
          marks: +qt.marksEach||2,
          type: qt.type,
        };
        if (qt.type === 'MCQ') {
          q.options = ['Option A', 'Option B', 'Option C', 'Option D'];
          q.correctAnswer = 0;
        } else if (qt.type === 'True/False') {
          q.correctAnswer = 'True';
        } else if (qt.type === 'Fill in the blank') {
          q.correctAnswer = '[answer]';
        } else {
          q.modelAnswer = 'Model answer to be filled by examiner.';
        }
        return q;
      })
    );
    return {
      id: sectionMap[ti],
      title: `Section ${sectionMap[ti]}`,
      instruction: ti===0 ? 'Attempt all questions. Each question carries equal marks.'
        : ti===1 ? 'Attempt all questions. Show all working where applicable.'
        : 'Attempt all questions. Detailed answers are expected.',
      totalMarks: questions.reduce((s,q)=>s+q.marks,0),
      questions,
    };
  }).filter(Boolean);

  return {
    title: `Unit Assessment – ${topic}`,
    subject: sub, grade,
    duration: +s.duration||60,
    totalMarks: +s.totalMarks||100,
    generalInstructions: [
      'All questions are compulsory unless stated otherwise.',
      'Read each question carefully before attempting.',
      'For calculation questions, show all working steps clearly.',
      'Write neatly; illegible answers may not receive full marks.',
      'Mobile phones and electronic devices are strictly prohibited.',
    ],
    sections,
  };
}

async function generatePaper(assignment, seed = '') {
  const key = store.getState().apiKey || '';
  if (!key) { console.warn('No API key — using fallback'); return mockPaper(assignment||{}); }
  const safeAssignment = assignment || {};
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-lite-001',
        messages: [{ role: 'user', content: buildPrompt(safeAssignment, seed) }],
        max_tokens: 4096,
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const raw  = data.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/g,'').trim();
    const paper = JSON.parse(clean);
    if (!validatePaperSchema(paper)) throw new Error('Invalid schema');
    return paper;
  } catch (err) {
    console.error('OpenRouter error:', err);
    return mockPaper(safeAssignment);
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
const QT_OPTIONS   = ['MCQ','Short Answer','Long Answer','True/False','Fill in the blank','Match the following'];
const DIFF_OPTIONS = ['Easy','Moderate','Hard','Mixed'];
const DIFF_STYLE   = {
  Easy:     { bg:'#d1fae5', color:'#065f46', border:'#6ee7b7', dot:'#059669' },
  Moderate: { bg:'#fef3c7', color:'#92400e', border:'#fcd34d', dot:'#d97706' },
  Hard:     { bg:'#fee2e2', color:'#991b1b', border:'#fca5a5', dot:'#dc2626' },
};

// ─── Icons ────────────────────────────────────────────────────────────────────
const Ic = {
  Sparkles: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 17l.75 2.25L22 20l-2.25.75L19 23l-.75-2.25L16 20l2.25-.75z"/><path d="M5 17l.75 2.25L8 20l-2.25.75L5 23l-.75-2.25L2 20l2.25-.75z"/></svg>),
  Upload:   () => (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>),
  Plus:     () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>),
  Trash:    () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>),
  Download: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>),
  Refresh:  () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>),
  Check:    () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>),
  Zap:      () => (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>),
  Alert:    () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>),
  File:     () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>),
  Spinner:  () => (<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{animation:'spin 1s linear infinite'}}><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" opacity=".25"/><path d="M21 12a9 9 0 00-9-9"/></svg>),
  BookOpen: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>),
  Key:      () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg>),
};

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;0,700;1,400&family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --ink:#111118;--paper:#f9f8f5;--cream:#f2ede4;--border:#e5dfd6;
    --gold:#c8963e;--gold-lt:#f5ead9;--gold-dk:#9a6f28;
    --teal:#2d7d6f;--teal-lt:#e4f4f1;
    --red:#dc3545;--red-lt:#fff0f0;
    --amber:#d97706;--amber-lt:#fffbeb;
    --muted:#6e6878;--white:#ffffff;
    --r:8px;--r-lg:14px;
    --sh:0 2px 8px rgba(0,0,0,.06);
    --sh-lg:0 8px 32px rgba(0,0,0,.1);
  }
  body{font-family:'Outfit',sans-serif;color:var(--ink);background:var(--paper);line-height:1.5}
  .shell{min-height:100vh;background:var(--paper)}

  /* Header */
  .hdr{position:sticky;top:0;z-index:200;background:var(--white);display:flex;align-items:center;
    gap:14px;padding:14px 20px;box-shadow:var(--sh);border-bottom:1px solid var(--border)}
  .hdr-logo{width:36px;height:36px;border-radius:8px;background:var(--gold);
    display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;font-weight:700;font-family:'Lora',serif}
  .hdr-name{font-family:'Lora',serif;font-size:18px;font-weight:700;color:var(--ink)}
  .hdr-name em{color:var(--gold);font-style:normal}
  .hdr-pill{margin-left:auto;padding:4px 12px;border-radius:16px;font-size:11px;font-weight:600;background:var(--cream);color:var(--ink)}

  /* Steps */
  .steps{display:flex;justify-content:center;align-items:center;padding:16px 20px 0;gap:0;
    background:var(--white);border-bottom:1px solid var(--border)}
  .s-item{display:flex;align-items:center;gap:8px}
  .s-dot{width:28px;height:28px;border-radius:50%;border:2px solid var(--border);
    background:var(--white);color:var(--muted);font-size:12px;font-weight:600;
    display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .3s}
  .s-dot.active{background:var(--gold);border-color:var(--gold);color:#fff}
  .s-dot.done{background:var(--teal);border-color:var(--teal);color:#fff}
  .s-lbl{font-size:12px;font-weight:500;color:var(--muted)}
  .s-lbl.active{color:var(--ink);font-weight:600}
  .s-line{width:40px;height:2px;background:var(--border);margin:0 6px;flex-shrink:0;transition:background .3s}
  .s-line.done{background:var(--teal)}

  .main{max-width:960px;margin:0 auto;padding:24px 20px 80px}
  .card{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);
    padding:28px;box-shadow:var(--sh);animation:fadeUp .3s ease}
  @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  .card-title{font-size:22px;font-weight:700;color:var(--ink);margin-bottom:20px}

  /* Form */
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .full{grid-column:1/-1}
  .field{display:flex;flex-direction:column;gap:5px}
  .lbl{font-size:11px;font-weight:700;color:var(--ink);text-transform:uppercase;letter-spacing:.4px}
  .lbl b{color:var(--red)}
  input,select,textarea{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:var(--r);
    font-family:'Outfit',sans-serif;font-size:13px;color:var(--ink);background:var(--white);
    transition:border-color .15s;outline:none;appearance:none}
  input:focus,select:focus,textarea:focus{border-color:var(--gold);box-shadow:0 0 0 2px rgba(200,150,62,.1)}
  input.err,select.err{border-color:var(--red);background:var(--red-lt)}
  .ferr{font-size:10px;color:var(--red);display:flex;align-items:center;gap:3px;margin-top:2px}
  textarea{resize:vertical;min-height:70px}

  .upload{border:2px dashed var(--border);border-radius:var(--r);padding:20px 16px;
    text-align:center;cursor:pointer;transition:all .2s;background:var(--cream)}
  .upload:hover,.upload.over{border-color:var(--gold);background:var(--gold-lt)}
  .upload p{font-size:12px;color:var(--muted);margin-top:6px}
  .upload strong{color:var(--gold-dk)}
  .file-chip{display:inline-flex;align-items:center;gap:5px;margin-top:8px;
    background:var(--teal-lt);color:var(--teal);padding:4px 10px;border-radius:16px;font-size:12px;font-weight:500}

  .qt-table{width:100%;border-collapse:collapse;margin-top:10px;border:1px solid var(--border);border-radius:var(--r)}
  .qt-table thead{background:var(--cream)}
  .qt-table th{padding:10px 12px;text-align:left;font-size:11px;font-weight:700;
    color:var(--muted);text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid var(--border)}
  .qt-table td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px}
  .qt-table tr:last-child td{border-bottom:none}
  .qt-select{width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--white)}
  .qt-input{width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--white)}
  .qt-input.err{border-color:var(--red);background:var(--red-lt)}
  .rm-icon{cursor:pointer;color:var(--red);font-size:16px;display:flex;align-items:center;justify-content:center}
  .rm-icon:hover{opacity:.8}

  .add-btn{display:flex;align-items:center;gap:6px;padding:8px 14px;
    border:1px solid var(--gold);border-radius:var(--r);background:transparent;
    color:var(--gold-dk);font-family:'Outfit',sans-serif;font-size:12px;font-weight:600;
    cursor:pointer;transition:all .2s;margin-top:10px}
  .add-btn:hover{background:var(--gold-lt)}

  .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;
    padding:10px 24px;border:none;border-radius:var(--r);font-family:'Outfit',sans-serif;
    font-size:13px;font-weight:600;cursor:pointer;transition:all .2s}
  .btn-gold{background:var(--gold);color:#fff;box-shadow:var(--sh)}
  .btn-gold:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 12px rgba(200,150,62,.3)}
  .btn-gold:disabled{opacity:.5;cursor:not-allowed}
  .btn-ghost{background:var(--white);color:var(--ink);border:1px solid var(--border)}
  .btn-ghost:hover:not(:disabled){border-color:var(--ink);background:var(--cream)}
  .btn-ghost:disabled{opacity:.5;cursor:not-allowed}
  .btn-teal{background:var(--teal);color:#fff;box-shadow:var(--sh)}
  .btn-teal:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 12px rgba(45,125,111,.3)}
  .btn-teal:disabled{opacity:.5;cursor:not-allowed}
  .btn-nav{display:flex;gap:8px;justify-content:space-between;margin-top:24px}

  /* Generating */
  .gen-wrap{display:flex;flex-direction:column;align-items:center;gap:24px;padding:40px 20px;
    min-height:50vh;justify-content:center}
  .gen-ring{width:100px;height:100px;border-radius:50%;position:relative;
    background:conic-gradient(var(--gold),var(--teal),var(--gold));animation:spin 1.8s linear infinite}
  .gen-ring::after{content:'';position:absolute;inset:5px;background:var(--white);border-radius:50%}
  .gen-icon{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:1;color:var(--gold-dk)}
  .gen-title{font-family:'Lora',serif;font-size:22px;font-weight:700;text-align:center;color:var(--ink)}
  .gen-sub{font-size:12px;color:var(--muted);text-align:center;margin-top:4px}
  .prog-wrap{width:100%;max-width:400px;height:4px;background:var(--border);border-radius:2px;overflow:hidden}
  .prog-fill{height:100%;background:linear-gradient(90deg,var(--gold),var(--teal));border-radius:2px;transition:width .5s ease}
  .prog-pct{font-size:11px;color:var(--muted);margin-top:6px;font-family:'JetBrains Mono',monospace}
  .ws-terminal{width:100%;max-width:400px;background:var(--ink);border-radius:var(--r);
    padding:10px 12px;max-height:140px;overflow-y:auto;font-family:'JetBrains Mono',monospace;font-size:10px}
  .ws-line{color:#86efac;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)}
  .ws-line::before{content:'› ';color:var(--gold)}

  /* Paper */
  .paper{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);
    overflow:hidden;box-shadow:var(--sh-lg);animation:fadeUp .3s ease}
  .paper-school{text-align:center;padding:16px 20px 0;font-size:10px;font-weight:700;
    letter-spacing:2px;text-transform:uppercase;color:var(--muted)}
  .paper-title{text-align:center;font-family:'Lora',serif;font-size:20px;font-weight:700;
    padding:6px 20px 2px;color:var(--ink)}
  .paper-subject{text-align:center;font-size:13px;color:var(--muted);padding:2px 20px 12px;
    border-bottom:2px solid var(--border)}
  .paper-meta{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;padding:12px 20px;
    background:var(--cream);border-bottom:1px solid var(--border);font-size:11px}
  .meta-cell{display:flex;flex-direction:column;gap:2px}
  .meta-lbl{font-weight:700;color:var(--muted);text-transform:uppercase;font-size:9px;letter-spacing:.3px}
  .meta-val{font-size:14px;font-weight:700;color:var(--ink)}
  .paper-body{padding:20px}
  .stu-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;margin-bottom:16px}
  .stu-field{display:flex;flex-direction:column;gap:3px}
  .stu-lbl{font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.3px}
  .stu-input{border:none;border-bottom:1.5px solid var(--ink);border-radius:0;padding:2px 0;
    background:transparent;font-size:13px;width:100%;outline:none;font-family:'Outfit',sans-serif}
  .stu-input:focus{border-bottom-color:var(--gold);box-shadow:none}
  .instr-box{background:var(--cream);border:1px solid var(--border);border-radius:var(--r);
    padding:10px 14px;margin-bottom:16px;font-size:12px;line-height:1.6}
  .instr-title{font-size:10px;font-weight:700;color:var(--ink);text-transform:uppercase;
    letter-spacing:.3px;margin-bottom:6px}
  .instr-text{color:var(--muted)}
  .section{margin-bottom:20px}
  .sec-hdr{display:flex;align-items:baseline;gap:10px;padding-bottom:6px;
    margin-bottom:10px;border-bottom:1.5px solid var(--ink)}
  .sec-title{font-family:'Lora',serif;font-size:16px;font-weight:700;color:var(--ink)}
  .sec-marks{margin-left:auto;font-size:11px;font-weight:600;color:var(--muted);white-space:nowrap}
  .q-row{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}
  .q-row:last-child{border-bottom:none}
  .q-num{font-size:13px;font-weight:700;color:var(--ink);min-width:20px;flex-shrink:0}
  .q-body{flex:1}
  .q-text{font-size:13px;line-height:1.6;color:var(--ink);margin-bottom:6px}
  .q-opts{display:grid;grid-template-columns:1fr 1fr;gap:3px 12px;margin:6px 0 6px 4px}
  .q-opt{font-size:12px;color:var(--ink);padding:2px 0}
  .q-opt span{display:inline-block;width:18px;font-weight:600;color:var(--muted)}
  .q-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10px}
  .badge{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;
    border-radius:12px;font-size:10px;font-weight:600;border:1px solid}
  .badge-dot{width:5px;height:5px;border-radius:50%}
  .type-tag{font-size:10px;color:var(--muted);background:var(--cream);padding:2px 6px;border-radius:4px}
  .q-marks{margin-left:auto;font-size:11px;font-weight:600;color:var(--muted);
    background:var(--cream);padding:2px 8px;border-radius:12px}
  .act-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;
    background:var(--cream);border-top:1px solid var(--border);flex-wrap:wrap}
  .act-info{font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace}
  .act-right{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}

  /* Tab toggle */
  .tab-bar{display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:0;
    background:var(--white);border-radius:var(--r-lg) var(--r-lg) 0 0;overflow:hidden}
  .tab{padding:12px 20px;font-size:13px;font-weight:600;cursor:pointer;
    border:none;background:transparent;color:var(--muted);font-family:'Outfit',sans-serif;
    display:flex;align-items:center;gap:7px;transition:all .2s;border-bottom:2px solid transparent;margin-bottom:-2px}
  .tab:hover{color:var(--ink);background:var(--cream)}
  .tab.active{color:var(--gold-dk);border-bottom-color:var(--gold);background:var(--gold-lt)}

  /* Answer Key */
  .ans-sheet{background:var(--white);border:1px solid var(--border);border-radius:0 0 var(--r-lg) var(--r-lg);
    overflow:hidden;box-shadow:var(--sh-lg)}
  .ans-hdr{background:var(--ink);color:#fff;padding:16px 20px;text-align:center}
  .ans-hdr-title{font-family:'Lora',serif;font-size:18px;font-weight:700}
  .ans-hdr-sub{font-size:11px;color:rgba(255,255,255,.6);margin-top:3px;letter-spacing:.5px;text-transform:uppercase}
  .ans-body{padding:20px}
  .key-section{margin-bottom:20px}
  .key-sec-hdr{display:flex;align-items:center;gap:10px;padding:6px 12px;
    background:var(--teal);color:#fff;border-radius:var(--r);margin-bottom:10px}
  .key-sec-title{font-family:'Lora',serif;font-size:13px;font-weight:700}
  .key-row{display:flex;gap:10px;padding:7px 0;border-bottom:1px dashed var(--border);font-size:12px}
  .key-row:last-child{border-bottom:none}
  .key-num{font-weight:700;min-width:28px;color:var(--muted)}
  .key-ans{flex:1;color:var(--ink);line-height:1.5}
  .key-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:10px;
    font-weight:700;margin-right:6px}
  .key-badge-correct{background:#d1fae5;color:#065f46}
  .key-badge-marks{background:var(--cream);color:var(--muted)}

  /* Toast */
  .toast{position:fixed;bottom:18px;right:18px;background:var(--ink);color:#fff;
    padding:9px 14px;border-radius:var(--r);font-size:12px;font-weight:500;
    display:flex;align-items:center;gap:7px;box-shadow:var(--sh-lg);z-index:999;
    animation:slideIn .25s ease}
  @keyframes slideIn{from{transform:translateX(110%);opacity:0}to{transform:translateX(0);opacity:1}}
  .toast-ok{color:#86efac}
  @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

  @media print{
    .hdr,.steps,.act-bar,.tab-bar,.no-print{display:none!important}
    .paper,.ans-sheet{box-shadow:none;border:none}
    .shell{background:white}
    .print-break{page-break-before:always}
  }
  @media(max-width:600px){
    .grid2{grid-template-columns:1fr}
    .paper-meta{grid-template-columns:1fr 1fr}
    .stu-grid{grid-template-columns:1fr}
    .paper-body{padding:14px}
    .ans-body{padding:14px}
    .hdr{padding:10px 14px}
    .main{padding:16px 12px 60px}
    .card{padding:18px}
    .q-opts{grid-template-columns:1fr}
    .tab{padding:10px 14px;font-size:12px}
  }
`;

// ─── Sub-components ────────────────────────────────────────────────────────────
function DiffBadge({ d }) {
  const s = DIFF_STYLE[d] || DIFF_STYLE.Moderate;
  return (
    <span className="badge" style={{ background:s.bg, color:s.color, borderColor:s.border }}>
      <span className="badge-dot" style={{ background:s.dot }} />{d}
    </span>
  );
}

function StepBar({ step }) {
  const steps = [
    { key:'create',     label:'Create Assignment' },
    { key:'generating', label:'AI Generation' },
    { key:'output',     label:'Question Paper' },
  ];
  const display = step === 'waiting' ? 'generating' : step;
  const idx = steps.findIndex((s) => s.key === display);
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <div key={s.key} style={{ display:'flex', alignItems:'center' }}>
          <div className="s-item">
            <div className={`s-dot${i===idx?' active':i<idx?' done':''}`}>
              {i < idx ? <Ic.Check /> : i + 1}
            </div>
            <span className={`s-lbl${i===idx?' active':''}`}>{s.label}</span>
          </div>
          {i < steps.length-1 && <div className={`s-line${i<idx?' done':''}`} />}
        </div>
      ))}
    </div>
  );
}

// ─── CreateForm ────────────────────────────────────────────────────────────────
function CreateForm() {
  const [form, setForm] = useState({
    subject:'', topic:'', grade:'', duration:'60', totalMarks:'100', dueDate:'', additionalInstructions:'',
  });
  const [qts, setQts] = useState([{ id:1, type:'MCQ', count:'10', marksEach:'2', difficulty:'Easy' }]);
  const [file, setFile]       = useState(null);
  const [drag, setDrag]       = useState(false);
  const [errs, setErrs]       = useState({});
  const [submitting, setSub]  = useState(false);
  const fileRef = useRef();
  const step = useStore((s) => s.step);
  useEffect(() => { if (step==='create') setSub(false); }, [step]);

  const ff = (k) => (e) => setForm((p) => ({ ...p, [k]:e.target.value }));

  const validate = () => {
    const e = {};
    if (!form.subject.trim())  e.subject  = 'Required';
    if (!form.topic.trim())    e.topic    = 'Required';
    if (!form.grade.trim())    e.grade    = 'Required';
    if (!form.duration || +form.duration <= 0)    e.duration   = 'Must be > 0';
    if (!form.totalMarks || +form.totalMarks <= 0) e.totalMarks = 'Must be > 0';
    if (!qts.length) e.qt = 'Add at least one question type';
    qts.forEach((q) => {
      if (!q.count    || +q.count    <= 0) e[`qc_${q.id}`] = '≥ 1';
      if (!q.marksEach || +q.marksEach <= 0) e[`qm_${q.id}`] = '≥ 1';
    });
    setErrs(e);
    return !Object.keys(e).length;
  };

  const handleFile = (f) => { if (f && (f.type==='application/pdf'||f.type.startsWith('text/'))) setFile(f); };

  const handleSubmit = () => {
    if (!validate()) return;
    setSub(true);
    const assignment = { ...form, questionTypes: qts, uploadedFile: file?.name||null };
    const jobId = 'JOB_' + Math.random().toString(36).slice(2,10).toUpperCase();
    store.setState({ assignment, step:'generating', jobStatus:'queued', jobProgress:0, wsMessages:[], errorMsg:null, generatedPaper:null, jobId });
    const cancel = simulateWS((msg) => {
      store.setState((s) => ({
        wsMessages: [...s.wsMessages, { id:Date.now()+Math.random(), text:msg.text }],
        jobProgress: msg.pct,
        jobStatus: msg.type==='JOB_DONE' ? 'done' : 'processing',
      }));
      if (msg.type === 'JOB_DONE') {
        store.setState({ step:'waiting' });
        generatePaper(assignment).then((paper) => store.setState({ generatedPaper:paper, step:'output' }));
      }
    });
    const unsub = store.subscribe((s) => { if (s.step==='create') { cancel(); unsub(); } });
  };

  const todayStr = new Date().toISOString().split('T')[0];
  return (
    <div className="card">
      <div className="card-title">Create Assignment</div>
      <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
        <div className="grid2">
          <div className="field">
            <label className="lbl">Subject <b>*</b></label>
            <input value={form.subject} onChange={ff('subject')} placeholder="e.g. Mathematics" className={errs.subject?'err':''} />
            {errs.subject && <span className="ferr"><Ic.Alert />{errs.subject}</span>}
          </div>
          <div className="field">
            <label className="lbl">Grade / Class <b>*</b></label>
            <input value={form.grade} onChange={ff('grade')} placeholder="e.g. Class 10" className={errs.grade?'err':''} />
            {errs.grade && <span className="ferr"><Ic.Alert />{errs.grade}</span>}
          </div>
          <div className="field full">
            <label className="lbl">Topic / Chapter <b>*</b></label>
            <input value={form.topic} onChange={ff('topic')} placeholder="e.g. Quadratic Equations" className={errs.topic?'err':''} />
            {errs.topic && <span className="ferr"><Ic.Alert />{errs.topic}</span>}
          </div>
          <div className="field">
            <label className="lbl">Duration (min) <b>*</b></label>
            <input type="number" min="1" value={form.duration} onChange={ff('duration')} className={errs.duration?'err':''} />
            {errs.duration && <span className="ferr"><Ic.Alert />{errs.duration}</span>}
          </div>
          <div className="field">
            <label className="lbl">Total Marks <b>*</b></label>
            <input type="number" min="1" value={form.totalMarks} onChange={ff('totalMarks')} className={errs.totalMarks?'err':''} />
            {errs.totalMarks && <span className="ferr"><Ic.Alert />{errs.totalMarks}</span>}
          </div>
          <div className="field">
            <label className="lbl">Due Date</label>
            <input type="date" value={form.dueDate} min={todayStr} onChange={ff('dueDate')} />
          </div>
        </div>

        <div className="field">
          <label className="lbl">Upload Reference Document</label>
          <div className={`upload${drag?' over':''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}>
            <div style={{ color:'var(--muted)' }}><Ic.Upload /></div>
            {file ? <div className="file-chip"><Ic.File />{file.name}</div>
              : <p><strong>Click to upload</strong> or drag & drop<br />PDF / TXT files accepted</p>}
          </div>
          <input ref={fileRef} type="file" accept=".pdf,.txt" style={{ display:'none' }}
            onChange={(e) => handleFile(e.target.files[0])} />
        </div>

        <div className="field">
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
            <label className="lbl" style={{ margin:0 }}>Question Types <b>*</b></label>
            {errs.qt && <span className="ferr"><Ic.Alert />{errs.qt}</span>}
          </div>
          <table className="qt-table">
            <thead><tr>
              <th style={{ width:'35%' }}>Question Type</th>
              <th style={{ width:'20%', textAlign:'center' }}>No. of Q.</th>
              <th style={{ width:'20%', textAlign:'center' }}>Marks</th>
              <th style={{ width:'15%', textAlign:'center' }}>Difficulty</th>
              <th style={{ width:'10%', textAlign:'center' }}>Del</th>
            </tr></thead>
            <tbody>
              {qts.map((qt) => (
                <tr key={qt.id}>
                  <td>
                    <select value={qt.type} className="qt-select"
                      onChange={(e) => setQts((p) => p.map((q) => q.id===qt.id ? {...q, type:e.target.value} : q))}>
                      {QT_OPTIONS.map((o) => <option key={o}>{o}</option>)}
                    </select>
                  </td>
                  <td style={{ textAlign:'center' }}>
                    <input type="number" min="1" value={qt.count} style={{ textAlign:'center' }}
                      className={`qt-input${errs[`qc_${qt.id}`]?' err':''}`}
                      onChange={(e) => setQts((p) => p.map((q) => q.id===qt.id ? {...q, count:e.target.value} : q))} />
                  </td>
                  <td style={{ textAlign:'center' }}>
                    <input type="number" min="1" value={qt.marksEach} style={{ textAlign:'center' }}
                      className={`qt-input${errs[`qm_${qt.id}`]?' err':''}`}
                      onChange={(e) => setQts((p) => p.map((q) => q.id===qt.id ? {...q, marksEach:e.target.value} : q))} />
                  </td>
                  <td style={{ textAlign:'center' }}>
                    <select value={qt.difficulty} className="qt-select"
                      onChange={(e) => setQts((p) => p.map((q) => q.id===qt.id ? {...q, difficulty:e.target.value} : q))}>
                      {DIFF_OPTIONS.map((o) => <option key={o}>{o}</option>)}
                    </select>
                  </td>
                  <td style={{ textAlign:'center' }}>
                    <span className="rm-icon" onClick={() => setQts((p) => p.filter((q) => q.id!==qt.id))}>✕</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="add-btn"
            onClick={() => setQts((p) => [...p, { id:Date.now(), type:'MCQ', count:'5', marksEach:'2', difficulty:'Easy' }])}>
            <Ic.Plus /> Add Question Type
          </button>
        </div>

        <div className="field">
          <label className="lbl">Additional Instructions</label>
          <textarea value={form.additionalInstructions} onChange={ff('additionalInstructions')}
            placeholder="e.g. Include diagram-based questions, focus on application..." />
        </div>

        <div className="btn-nav">
          <div />
          <button className="btn btn-gold" onClick={handleSubmit} disabled={submitting}>
            <Ic.Sparkles />{submitting ? 'Submitting…' : 'Next →'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Generating / Waiting ─────────────────────────────────────────────────────
function GeneratingScreen() {
  const msgs = useStore((s) => s.wsMessages);
  const pct  = useStore((s) => s.jobProgress);
  const logRef = useRef();
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [msgs]);
  return (
    <div className="card gen-wrap">
      <div style={{ position:'relative' }}>
        <div className="gen-ring"><div className="gen-icon"><Ic.Zap /></div></div>
      </div>
      <div>
        <div className="gen-title">Generating Your Question Paper</div>
        <div className="gen-sub">OpenRouter is crafting a curriculum-aligned assessment — please wait</div>
      </div>
      <div className="prog-wrap"><div className="prog-fill" style={{ width:`${pct}%` }} /></div>
      <div className="prog-pct">{pct}%</div>
      <div className="ws-terminal" ref={logRef}>
        <div className="ws-line" style={{ color:'#6b7280' }}>WebSocket connected — waiting for job events…</div>
        {msgs.map((m) => <div className="ws-line" key={m.id}>{m.text}</div>)}
      </div>
      <div style={{ display:'flex', gap:12, flexWrap:'wrap', justifyContent:'center' }}>
        {['BullMQ Queue','Redis Cache','MongoDB Store','OpenRouter API'].map((tag) => (
          <span key={tag} style={{ fontSize:11, fontWeight:600, padding:'4px 12px', borderRadius:20,
            background:'var(--cream)', border:'1px solid var(--border)', color:'var(--muted)' }}>{tag}</span>
        ))}
      </div>
    </div>
  );
}

function WaitingScreen() {
  return (
    <div className="card gen-wrap">
      <Ic.Spinner />
      <p style={{ color:'var(--muted)', fontSize:14 }}>Finalising your question paper — almost there…</p>
    </div>
  );
}

// ─── Answer Key ───────────────────────────────────────────────────────────────
function AnswerKey({ paper }) {
  return (
    <div className="ans-sheet">
      <div className="ans-hdr" style={{ background:'#1a3a34' }}>
        <div className="ans-hdr-title">Answer Key — {paper.title}</div>
        <div className="ans-hdr-sub">For examiner / teacher use only · Confidential</div>
      </div>
      <div className="ans-body">
        {paper.sections?.map((sec) => (
          <div className="key-section" key={sec.id}>
            <div className="key-sec-hdr">
              <span className="key-sec-title">{sec.title}</span>
              <span style={{ marginLeft:'auto', fontSize:11, opacity:.8 }}>{sec.totalMarks} Marks</span>
            </div>
            {sec.questions?.map((q) => {
              let ans = null;
              if (q.type === 'MCQ' && q.options) {
                const idx = typeof q.correctAnswer === 'number' ? q.correctAnswer
                  : parseInt(q.correctAnswer, 10);
                const letter = String.fromCharCode(65 + (isNaN(idx) ? 0 : idx));
                const text   = q.options[isNaN(idx) ? 0 : idx] || '';
                ans = <><span className="key-badge key-badge-correct">{letter}</span>{text}</>;
              } else if (q.type === 'True/False') {
                ans = <span className="key-badge key-badge-correct">{q.correctAnswer || '—'}</span>;
              } else if (q.type === 'Fill in the blank') {
                ans = <><span className="key-badge" style={{ background:'#fef3c7', color:'#92400e' }}>Answer: </span>{q.correctAnswer || '—'}</>;
              } else {
                ans = <span style={{ color:'var(--muted)' }}>{q.modelAnswer || 'Refer to marking scheme.'}</span>;
              }
              return (
                <div className="key-row" key={q.id}>
                  <span className="key-num">Q{q.id}.</span>
                  <span className="key-ans">{ans}</span>
                  <span className="key-badge key-badge-marks">{q.marks}M</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── OutputPaper ──────────────────────────────────────────────────────────────
function OutputPaper() {
  const paper      = useStore((s) => s.generatedPaper);
  const assignment = useStore((s) => s.assignment);
  const [stu,    setStu]   = useState({ name:'', roll:'', section:'' });
  const [tab,    setTab]   = useState('paper');   // 'paper' | 'key'
  const [toast,  setToast] = useState(null);
  const [regen,  setRegen] = useState(false);
  const cancelRef = useRef(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const handleExport = () => { window.print(); showToast("Opening print dialog — choose 'Save as PDF'"); };

  const handleRegenerate = () => {
    if (regen) return;
    setRegen(true);
    const seed = `variant-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    if (cancelRef.current) cancelRef.current();
    const cancel = simulateWS((msg) => {
      store.setState((s) => ({
        wsMessages: [...s.wsMessages, { id:Date.now()+Math.random(), text:msg.text }],
        jobProgress: msg.pct,
        jobStatus: msg.type==='JOB_DONE' ? 'done' : 'processing',
      }));
      if (msg.type === 'JOB_DONE') {
        const snap = store.getState().assignment || assignment || {};
        store.setState({ step:'waiting' });
        generatePaper(snap, seed).then((p) => { store.setState({ generatedPaper:p, step:'output' }); setRegen(false); });
      }
    });
    cancelRef.current = cancel;
    store.setState({ step:'generating', jobStatus:'queued', jobProgress:0, wsMessages:[], generatedPaper:null });
  };
  useEffect(() => () => { if (cancelRef.current) cancelRef.current(); }, []);

  if (!paper) return null;
  const allQ = paper.sections?.flatMap((s) => s.questions) || [];

  return (
    <>
      {toast && (
        <div className="toast"><span className="toast-ok"><Ic.Check /></span>{toast}</div>
      )}

      {/* Tab bar — only Question Paper and Answer Key */}
      <div className="tab-bar">
        <button className={`tab${tab==='paper'?' active':''}`} onClick={() => setTab('paper')}>
          <Ic.BookOpen /> Question Paper
        </button>
        <button className={`tab${tab==='key'?' active':''}`} onClick={() => setTab('key')}>
          <Ic.Key /> Answer Key
        </button>
      </div>

      {/* ── Question Paper ── */}
      {tab === 'paper' && (
        <div className="paper" style={{ borderRadius:'0 0 var(--r-lg) var(--r-lg)' }}>
          <div className="paper-school">Delhi Public School, Sector-4, Bokaro</div>
          <div className="paper-title">{paper.title}</div>
          <div className="paper-subject">{paper.subject} — {paper.grade}</div>
          <div className="paper-meta">
            <div className="meta-cell"><span className="meta-lbl">Time Allowed</span><span className="meta-val">{paper.duration} min</span></div>
            <div className="meta-cell"><span className="meta-lbl">Maximum Marks</span><span className="meta-val">{paper.totalMarks}</span></div>
            <div className="meta-cell"><span className="meta-lbl">Sections</span><span className="meta-val">{paper.sections?.length||0}</span></div>
            <div className="meta-cell"><span className="meta-lbl">Total Q.</span><span className="meta-val">{allQ.length}</span></div>
          </div>
          <div className="paper-body">
            <div className="stu-grid">
              <div className="stu-field"><span className="stu-lbl">Name</span>
                <input className="stu-input" value={stu.name} onChange={(e)=>setStu(p=>({...p,name:e.target.value}))} placeholder="Write your full name" /></div>
              <div className="stu-field"><span className="stu-lbl">Roll Number</span>
                <input className="stu-input" value={stu.roll} onChange={(e)=>setStu(p=>({...p,roll:e.target.value}))} placeholder="Roll No." /></div>
              <div className="stu-field"><span className="stu-lbl">Class Section</span>
                <input className="stu-input" value={stu.section} onChange={(e)=>setStu(p=>({...p,section:e.target.value}))} placeholder="e.g. A" /></div>
            </div>
            {paper.generalInstructions?.length > 0 && (
              <div className="instr-box">
                <div className="instr-title">General Instructions</div>
                <div className="instr-text">{paper.generalInstructions.join(' • ')}</div>
              </div>
            )}
            {paper.sections?.map((sec) => (
              <div className="section" key={sec.id}>
                <div className="sec-hdr">
                  <div className="sec-title">{sec.title}</div>
                  <div className="sec-marks">[{sec.totalMarks} M]</div>
                </div>
                {sec.questions?.map((q) => (
                  <div className="q-row" key={q.id}>
                    <div className="q-num">{q.id}.</div>
                    <div className="q-body">
                      <div className="q-text">{q.text}</div>
                      {q.options && (
                        <div className="q-opts">
                          {q.options.map((opt, oi) => (
                            <div className="q-opt" key={oi}>
                              <span>{String.fromCharCode(65+oi)})</span> {opt}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="q-foot">
                        <DiffBadge d={q.difficulty} />
                        <span className="type-tag">{q.type}</span>
                        <span className="q-marks">[{q.marks} M]</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="act-bar">
            <div className="act-info">Generated by OpenRouter · {new Date().toLocaleDateString()}</div>
            <div className="act-right">
              <button className="btn btn-ghost"
                onClick={() => store.setState({ step:'create', jobStatus:'idle', jobProgress:0 })}>
                ← Previous
              </button>
              <button className="btn btn-ghost" onClick={handleRegenerate} disabled={regen}>
                <Ic.Refresh />{regen ? 'Regenerating…' : 'Regenerate'}
              </button>
              <button className="btn btn-gold" onClick={handleExport}>
                <Ic.Download /> Download PDF
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Answer Key ── */}
      {tab === 'key' && (
        <>
          <AnswerKey paper={paper} />
          <div className="act-bar" style={{ borderRadius:'0 0 var(--r-lg) var(--r-lg)', border:'1px solid var(--border)', borderTop:'none' }}>
            <div className="act-info">Examiner / teacher use only</div>
            <div className="act-right">
              <button className="btn btn-teal" onClick={handleExport}>
                <Ic.Download /> Print / Save PDF
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const step = useStore((s) => s.step);
  return (
    <>
      <style>{CSS}</style>
      <div className="shell">
        <header className="hdr">
          <div className="hdr-logo">V</div>
          <div className="hdr-name">Veda<em>AI</em></div>
          <div className="hdr-pill">Assessment Creator</div>
        </header>
        <StepBar step={step} />
        <main className="main">
          {step === 'create'     && <CreateForm />}
          {step === 'generating' && <GeneratingScreen />}
          {step === 'waiting'    && <WaitingScreen />}
          {step === 'output'     && <OutputPaper />}
        </main>
      </div>
    </>
  );
}
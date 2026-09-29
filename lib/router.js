'use strict';

// Difficulty levels map to a model + effort chosen in Settings > Models.
const LEVELS = ['easy', 'medium', 'hard', 'extraHard'];
const LEVEL_EFFORT = { easy: 'low', medium: 'medium', hard: 'high', extraHard: 'max' };
const toModelId = m => {
  const raw = String(m || '').trim();
  if (!raw || /^claude-/i.test(raw) || /^[a-z]+$/i.test(raw)) return raw;
  return 'claude-' + raw.toLowerCase().replace(/[\s.]+/g, '-');
};
function ladder() {
  const c = require('./config').get();
  const def = (c.workers && c.workers.defaultModel) || 'claude-opus-5-5';
  return LEVELS.map((level, tier) => {
    const l = (c.levels && c.levels[level]) || {};
    const model = toModelId(l.model || def);
    const effort = l.effort || LEVEL_EFFORT[level];
    return { model, effort, lean: false, tier, level, label: `${level}: ${model}/${effort}` };
  });
}
const MID_TIER = 1;
const TOP_ROUTED_TIER = LEVELS.length - 2;
// When several levels share a model + effort (Settings › Models allows it), a task on that pair is on
// the HIGHEST of them: taking the first one made escalate() "move up" to an identical rung, so a
// failing task re-ran on the same model with no cap.
const tierOf = (model, effort) => {
  const L = ladder();
  const hit = [...L].reverse().find(l => l.model === toModelId(model) && l.effort === effort);
  if (hit) return hit.tier;
  const byEffort = L.find(l => l.effort === (effort === 'xhigh' ? 'high' : effort));
  return byEffort ? byEffort.tier : MID_TIER;
};
const rung = tier => { const L = ladder(); return L[Math.max(0, Math.min(L.length - 1, tier))]; };

const RX = {
  trivial: /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|status\??)\b|^\s*(what time|what'?s the date)/i,
  simple: /\b(rename|typo|format|prettify|lint|list(\s+\w+){0,2}\s+(files?|dirs?|folders?|tasks?)|show me|print|echo|cat |convert\s+(this\s+)?to\s+(json|csv|yaml)|summari[sz]e\s+(this|the)\s+(short|brief))\b/i,
  lookup: /\b(find|search|locate|grep|where is|which file|look up|read the|show the)\b/i,
  code: /\b(implement|add|write|create|build|refactor|migrate|patch|fix|edit|update|change|rewrite|port)\b/i,
  debug: /\b(debug|why (is|does|did|isn'?t|doesn'?t)|root ?cause|failing|broken|crash|error|exception|regression|stack ?trace|not working|hangs?|leak)\b/i,
  research: /\b(research|investigate|compare|evaluate|options|trade-?offs?|survey|analy[sz]e|audit|review)\b/i,
  architecture: /\b(architect|design|orchestrat|system|end-to-end|whole (app|system|codebase)|strategy|plan the|from scratch)\b/i,
  ops: /\b(restart|deploy|schedule|scheduled task|service|process|kill|install|configure|cron|watchdog)\b/i,
  hard: /\b(concurren|race condition|deadlock|distributed|security|cryptograph|performance|optimi[sz]e|scal(e|ing)|thread|memory (leak|corruption)|data loss|correctness|proof)\b/i,
  broad: /\b(all (files|tests|modules)|every|entire|across the (repo|codebase|project)|codebase[- ]wide|repo[- ]wide|bulk|mass)\b/i,
};

const COMPLEXITY_TIER = { trivial: 0, simple: 0, moderate: 1, complex: 2, severe: 2 };

function classifyRules(prompt) {
  const p = String(prompt || '');
  const words = p.trim().split(/\s+/).filter(Boolean).length;
  const signals = [];
  const hit = k => { if (RX[k].test(p)) { signals.push(k); return true; } return false; };

  const isTrivial = hit('trivial');
  const isSimple = hit('simple');
  const isLookup = hit('lookup');
  const isCode = hit('code');
  const isDebug = hit('debug');
  const isResearch = hit('research');
  const isArch = hit('architecture');
  const isOps = hit('ops');
  const isHard = hit('hard');
  const isBroad = hit('broad');

  let type = 'general';
  if (isArch) type = 'architecture';
  else if (isDebug) type = 'debug';
  else if (isResearch) type = 'research';
  else if (isCode) type = 'code';
  else if (isOps) type = 'ops';
  else if (isLookup) type = 'lookup';
  else if (isSimple || isTrivial) type = 'trivial';

  let complexity;
  if (isTrivial && words <= 12) complexity = 'trivial';
  else if (type === 'trivial' || (isSimple && words <= 40)) complexity = 'simple';
  else if (type === 'lookup' && !isBroad) complexity = 'simple';
  else if (type === 'architecture') complexity = 'complex';
  else if (type === 'debug' || type === 'research') complexity = 'moderate';
  else complexity = 'moderate';

  if (isHard) complexity = complexity === 'complex' ? 'severe' : 'complex';
  if (isBroad && complexity !== 'severe') {
    complexity = complexity === 'complex' ? 'severe' : 'complex';
  }
  if (words > 220 && ['trivial', 'simple', 'moderate'].includes(complexity)) complexity = 'complex';

  let confidence = 0.5;
  if (isTrivial && words <= 12) confidence = 0.97;
  else if (signals.length >= 2) confidence = 0.85;
  else if (signals.length === 1) confidence = 0.7;
  else if (words <= 8) confidence = 0.75;
  else confidence = 0.45;

  return { type, complexity, confidence, signals, words };
}

function route(prompt, opts = {}) {
  const c = classifyRules(prompt);
  let tier = COMPLEXITY_TIER[c.complexity] != null ? COMPLEXITY_TIER[c.complexity] : MID_TIER;

  if (c.confidence < 0.6 && c.complexity !== 'trivial') tier = Math.min(tier + 1, TOP_ROUTED_TIER);
  if (opts.minTier != null) tier = Math.max(tier, opts.minTier);

  const r = rung(tier);
  const model = opts.forceModel || r.model;
  const effort = opts.forceEffort || r.effort;
  const lean = opts.forceModel ? false : r.lean;

  const mode = (c.complexity === 'trivial') ? 'inline' : 'worker';

  const isolate = !!opts.isolate || c.complexity === 'severe' || c.signals.includes('broad');

  return {
    type: c.type,
    complexity: c.complexity,
    confidence: c.confidence,
    signals: c.signals,
    model, effort, lean, mode, isolate,
    tier: tierOf(model, effort),
    reason: `rules: type=${c.type} complexity=${c.complexity} conf=${c.confidence.toFixed(2)}` +
            (c.signals.length ? ` signals=[${c.signals.join(',')}]` : '') + ` -> ${model}/${effort}${lean ? ' (lean)' : ''}`,
  };
}

function escalate(model, effort) {
  const L = ladder();
  const cur = { model: toModelId(model), effort };
  // The next level that actually changes something; none left means the task is at the top.
  const n = L.slice(tierOf(model, effort) + 1).find(l => l.model !== cur.model || l.effort !== cur.effort);
  if (!n) return null;
  return { model: n.model, effort: n.effort, lean: n.lean, label: n.label };
}

function needsModelAssist(prompt) {
  const c = classifyRules(prompt);
  return c.confidence < 0.55 && c.words > 25;
}

module.exports = { route, classifyRules, escalate, needsModelAssist, tierOf, rung, ladder, LEVELS, toModelId,
  get LADDER() { return ladder(); }, get MODEL() { return ladder()[MID_TIER].model; } };

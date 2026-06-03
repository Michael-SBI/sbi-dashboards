#!/usr/bin/env node
/**
 * SBI CEO Lens — Internal Perspective (weekly)
 * =============================================
 * Calls Claude Opus 4.7 with the full internal dataset (no web search) and
 * returns 5-8 recommendations grounded entirely in SBI's own data. Plays
 * the role of an experienced operations + finance partner who has been
 * inside the business for years and can spot patterns the team is too
 * close to see.
 *
 * Where ceo-advice.js looks OUTWARD (competitors, market, regulation),
 * this one looks INWARD (estimating accuracy, cycle-time bottlenecks,
 * client concentration, capacity flags, margin variance).
 *
 * Inputs
 *   - performance.json (per-job archived metrics + sales pipeline)
 *
 * Outputs
 *   - ceo-advice-internal.json
 *
 * Cadence: weekly. Skips silently if existing file is less than 7 days
 * old. Pass --force to override.
 *
 * Cost: ~$0.30-$1.00 per run (no web search, just text reasoning + thinking).
 *
 * Environment: ANTHROPIC_API_KEY
 *
 * Usage:
 *   node ceo-advice-internal.js
 *   node ceo-advice-internal.js --force
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname);
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const MODEL = 'claude-opus-4-7';
const STALE_DAYS = 7;
const FORCE = process.argv.includes('--force');

function log(...a) { console.log('[ceo-int]', ...a); }
function warn(...a) { console.warn('[ceo-int] WARN:', ...a); }
function err(...a) { console.error('[ceo-int] ERROR:', ...a); }

function shouldSkip() {
  if (FORCE) return false;
  const p = path.join(REPO_ROOT, 'ceo-advice-internal.json');
  if (!fs.existsSync(p)) return false;
  const ageDays = (Date.now() - fs.statSync(p).mtimeMs) / (24 * 60 * 60 * 1000);
  if (ageDays < STALE_DAYS) {
    log(`existing file is ${ageDays.toFixed(1)}d old (<${STALE_DAYS}d). Skipping. Pass --force to override.`);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Build a richer internal context than the external lens needs
// ─────────────────────────────────────────────────────────────

function buildContext() {
  const perfPath = path.join(REPO_ROOT, 'performance.json');
  if (!fs.existsSync(perfPath)) {
    throw new Error('performance.json missing — run performance.js first');
  }
  const perf = JSON.parse(fs.readFileSync(perfPath, 'utf8'));
  const sales = perf.sales || {};
  const jobs = perf.jobs || [];
  const archived = jobs.filter(j => j.archived);
  const active = jobs.filter(j => !j.archived);

  // Per-job rich detail for archived jobs (these are completed; reliable signal)
  const archivedDetail = archived.map(j => ({
    jobNumber: j.jobNumber,
    name: j.name,
    type: j.type,
    pm: j.pm,
    soldDate: j.soldDate,
    completedDate: j.completedDate,
    revenueExGST: j.revenueExGST,
    paidRevenueExGST: j.paidRevenueExGST,
    plannedCost: j.plannedCost,
    actualCost: j.actualCost,
    plannedMarginPct: j.plannedMarginPct,
    actualMarginPct: j.actualMarginPct,
    marginGap: j.actualMarginPct !== null && j.plannedMarginPct !== null
      ? Math.round((j.actualMarginPct - j.plannedMarginPct) * 10) / 10
      : null,
    labourBudget: j.labourBudget,
    labourActual: j.labourActual,
    labourOverrun: j.labourOverrun,
    buildCycleDays: j.buildCycleDays,
    siteDays: j.siteDays,
    salesCycleDays: j.salesCycleDays,
    profitPerBuildDay: j.profitPerBuildDay,
    variationCount: j.variationCount,
    variationPctOfContract: j.variationPctOfContract,
  }));

  // Per-job lighter detail for active jobs (in flight)
  const activeDetail = active.map(j => ({
    jobNumber: j.jobNumber,
    name: j.name,
    type: j.type,
    pm: j.pm,
    soldDate: j.soldDate,
    revenueExGST: j.revenueExGST,
    plannedMarginPct: j.plannedMarginPct,
    actualMarginPct: j.actualMarginPct,
    labourOverrun: j.labourOverrun,
    variationCount: j.variationCount,
    variationPctOfContract: j.variationPctOfContract,
  }));

  // Per-PM rollups (capacity + reliability signals)
  const pmRollup = {};
  jobs.forEach(j => {
    if (!j.pm) return;
    if (!pmRollup[j.pm]) pmRollup[j.pm] = { active: 0, archived: 0, marginGaps: [], cycleDays: [], varPcts: [] };
    pmRollup[j.pm][j.archived ? 'archived' : 'active']++;
    if (j.actualMarginPct !== null && j.plannedMarginPct !== null) pmRollup[j.pm].marginGaps.push(j.actualMarginPct - j.plannedMarginPct);
    if (j.buildCycleDays !== null) pmRollup[j.pm].cycleDays.push(j.buildCycleDays);
    if (j.variationPctOfContract !== null) pmRollup[j.pm].varPcts.push(j.variationPctOfContract);
  });
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const pmSummary = Object.entries(pmRollup).map(([pm, v]) => ({
    pm,
    activeJobs: v.active,
    archivedJobs: v.archived,
    avgMarginGap: avg(v.marginGaps) === null ? null : Math.round(avg(v.marginGaps) * 10) / 10,
    avgBuildCycle: avg(v.cycleDays) === null ? null : Math.round(avg(v.cycleDays)),
    avgVariationPct: avg(v.varPcts) === null ? null : Math.round(avg(v.varPcts) * 10) / 10,
  }));

  // Sales pipeline current shape
  const pipelineByStage = {};
  (sales.deals || []).filter(d => d.outcome === 'open').forEach(d => {
    const types = d.types.length ? d.types : ['(no type)'];
    types.forEach(t => {
      if (!pipelineByStage[t]) pipelineByStage[t] = { count: 0, totalValue: 0 };
      pipelineByStage[t].count++;
      pipelineByStage[t].totalValue += d.dealValue || 0;
    });
  });

  // Concentration risk — top clients by total won value
  const clientValue = {};
  (sales.deals || []).filter(d => d.outcome === 'won').forEach(d => {
    if (!d.clientKey) return;
    if (!clientValue[d.clientKey]) clientValue[d.clientKey] = { name: d.name, total: 0, count: 0 };
    clientValue[d.clientKey].total += d.dealValue || 0;
    clientValue[d.clientKey].count++;
  });
  const topClients = Object.values(clientValue).sort((a, b) => b.total - a.total).slice(0, 10);

  // Win-rate-by-deal-size buckets — are we losing the bigger ones?
  const sizeBands = [
    { label: '<$25k', min: 0, max: 25000 },
    { label: '$25k-$75k', min: 25000, max: 75000 },
    { label: '$75k-$150k', min: 75000, max: 150000 },
    { label: '$150k-$300k', min: 150000, max: 300000 },
    { label: '$300k+', min: 300000, max: Infinity },
  ];
  const sizeBandStats = sizeBands.map(b => {
    const matching = (sales.deals || []).filter(d => d.dealValue !== null && d.dealValue >= b.min && d.dealValue < b.max);
    const won = matching.filter(d => d.outcome === 'won').length;
    const lost = matching.filter(d => d.outcome === 'lost').length;
    return { band: b.label, won, lost, winRate: (won + lost) > 0 ? Math.round(won / (won + lost) * 100) : null };
  });

  return {
    asOf: new Date().toISOString().slice(0, 10),
    overall: {
      totalArchived: archived.length,
      totalActive: active.length,
      totalDeals: sales.totalDeals,
      wonCount: sales.wonCount,
      lostCount: sales.lostCount,
      ambiguousCount: sales.ambiguousCount,
      overallWinRate: sales.overallWinRate,
      overallAvgSalesCycleDays: sales.overallAvgSalesCycleDays,
    },
    archivedJobs: archivedDetail,
    activeJobs: activeDetail,
    pmSummary,
    pipelineByStage,
    topClientsByValue: topClients,
    sizeBandStats,
    typesSummary: Object.entries(sales.byType || {})
      .filter(([k, v]) => k !== '(no type set)' && (v.won + v.lost) >= 5)
      .map(([k, v]) => ({ type: k, won: v.won, lost: v.lost, winRate: v.winRate, avgWonValue: v.avgWonValue, ambiguousCount: v.ambiguous })),
    sourcesSummary: Object.entries(sales.byLeadSource || {})
      .filter(([k, v]) => k !== '(unknown)' && v.total >= 3)
      .map(([k, v]) => ({ source: k, total: v.total, won: v.won, lost: v.lost, winRate: v.winRate, avgWonValue: v.avgWonValue })),
    repeatClients: (sales.repeatClients || []).map(c => ({ name: c.displayName, deals: c.dealCount, won: c.wonCount, totalWonValue: c.totalWonValue })),
  };
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    weekCovered: { type: 'string', description: 'Week-ending date e.g. "Week ending 3 Jun 2026"' },
    keyInsight: { type: 'string', description: 'One-sentence headline — the single most important internal pattern to act on this week (max 30 words)' },
    recommendations: {
      type: 'array', minItems: 5, maxItems: 8,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Punchy title (max 12 words)' },
          category: { type: 'string', enum: ['Estimating', 'Cycle Time', 'Margin Risk', 'Pipeline Health', 'Client Concentration', 'Operations', 'Capacity', 'Sales Process'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          horizon: { type: 'string', enum: ['this-week', 'this-quarter', '6-months'] },
          evidence: { type: 'string', description: '2-3 sentences with SPECIFIC SBI numbers — quote actual job names, PM names, deal values, margins. No generic claims.' },
          dataPoints: { type: 'array', description: '2-5 specific data quotes from the SBI dataset that support the recommendation', items: { type: 'string' } },
          reasoning: { type: 'string', description: 'Why this matters specifically for SBI now — connect dots across jobs/clients/PMs (1-2 sentences)' },
          action: { type: 'string', description: 'Specific action, verb-first, max 25 words' },
          impact: { type: 'string', description: 'Expected outcome if acted on, quantified where possible. Max 20 words.' },
        },
        required: ['title', 'category', 'confidence', 'horizon', 'evidence', 'dataPoints', 'reasoning', 'action', 'impact'],
      },
    },
    patternsObserved: {
      type: 'object',
      properties: {
        notes: { type: 'string', description: '2-4 sentences on cross-cutting observations from the current data — things worth watching even if not yet an action.' },
      },
    },
  },
  required: ['weekCovered', 'keyInsight', 'recommendations', 'patternsObserved'],
};

const SYSTEM_PROMPT = `You are SBI's internal strategy partner — a fractional COO + CFO who has been inside the business for years and has direct access to the books, jobs ledger, sales pipeline, and team capacity data. You play the role of someone who can see across what individual team members can't.

Your job is to read SBI's live internal data and surface 5-8 recommendations grounded ENTIRELY in their own numbers. You have no web search; you don't need it. Everything you say must reference actual SBI data — specific job names, PM names, deal sizes, margin gaps, cycle days.

What to look for:

1. **Estimating accuracy patterns** — where do planned and actual margins diverge most? Is one PM consistently estimating tight or loose? Are certain job types systematically under-budgeted on labour? Quote specific jobs.

2. **Cycle-time bottlenecks** — which archived jobs ran much longer than peers (build cycle, sales cycle, site days)? What did they have in common (client type, scope, season)? Are active jobs trending into the same trap?

3. **Margin variance + risk** — jobs where actual margin came in materially above OR below planned. Below = lost money. Above = often labour wasn't recorded (data quality issue, not a real win). Either way, surface specific jobs.

4. **Client concentration risk** — if any single client is >20% of recent revenue, flag it. If a top repeat client hasn't engaged in 6+ months, surface it as an at-risk relationship.

5. **Pipeline health** — what's the current open pipeline by stage + value? Is the funnel top-heavy (lots of inquiries, nothing in presentation/closing) or bottom-heavy (deals stuck in close-won stage)?

6. **Capacity flags** — does any PM look overloaded (many active jobs, longer cycles, more variations)? Is anyone underutilised?

7. **Win-rate by deal size** — are SBI losing the bigger deals (signal: pricing problem, brand credibility, capability perception) or the smaller ones (signal: process drag on small jobs)?

8. **Repeat-business momentum** — among repeat clients, what's the time-between-deals trend? Lengthening = relationship cooling; tightening = warming.

Each recommendation must:
- Cite **at least 2 specific data points** from the SBI dataset (jobs, PMs, numbers — not vague claims)
- Be **actionable this week or this quarter** — bias toward operational moves the team can make immediately
- Connect dots that **a single team member would miss** because they only see their slice

Avoid:
- Restating high-level metrics back ("your overall win rate is 47%")
- Telling them to "tag more deals" or "track labour better" — that's the Data Quality Backlog's job
- Recommendations that need external research (those go in the External Lens)
- Generic management advice

Bias toward:
- Pattern-spotting across jobs that the dashboard rows don't show side-by-side
- Early warnings on active jobs that look like they'll repeat archived-job mistakes
- Specific named-job interventions ("Job X: do Y before next Tuesday")

Also fill the patternsObserved.notes field with 2-4 sentences on cross-cutting things worth watching — slow shifts, emerging concentrations, things that aren't yet a 5-alarm fire but will be if ignored.

Treat this like a Monday-morning operations briefing for the leadership team.`;

function buildUserMessage(ctx) {
  return [
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## SBI internal dataset — current snapshot',
    '```json',
    JSON.stringify(ctx, null, 2),
    '```',
    '',
    'Analyse this and produce 5-8 internal recommendations using the submit_internal_recommendations tool. Be specific — name jobs, name PMs, quote numbers. Surface patterns the team would miss by reading the dashboard one row at a time.',
  ].join('\n');
}

async function callClaude(ctx) {
  const tools = [
    {
      name: 'submit_internal_recommendations',
      description: 'Submit the final 5-8 internal-perspective recommendations after analysing the SBI dataset. Call this exactly once.',
      input_schema: OUTPUT_SCHEMA,
    },
  ];

  const body = {
    model: MODEL,
    max_tokens: 12000,
    system: SYSTEM_PROMPT,
    tools,
    tool_choice: { type: 'tool', name: 'submit_internal_recommendations' },
    messages: [{ role: 'user', content: buildUserMessage(ctx) }],
  };

  log(`calling ${MODEL} with structured output (no web search)…`);
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  log(`response in ${elapsed}s · input: ${data.usage.input_tokens} · output: ${data.usage.output_tokens}`);

  const submit = (data.content || []).find(c => c.type === 'tool_use' && c.name === 'submit_internal_recommendations');
  if (!submit) {
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 1000);
    throw new Error('Tool not called. Last text: ' + text);
  }
  return { result: submit.input, usage: data.usage };
}

async function main() {
  if (!API_KEY) { err('ANTHROPIC_API_KEY not set. Internal CEO Lens skipped.'); process.exit(0); }
  if (shouldSkip()) process.exit(0);

  const ctx = buildContext();
  log(`built context: ${ctx.overall.totalArchived} archived, ${ctx.overall.totalActive} active, ${ctx.overall.totalDeals} deals`);

  const { result, usage } = await callClaude(ctx);

  const out = {
    generated: new Date().toISOString(),
    model: MODEL,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    ...result,
  };
  fs.writeFileSync(path.join(REPO_ROOT, 'ceo-advice-internal.json'), JSON.stringify(out, null, 2), 'utf8');
  log(`wrote ceo-advice-internal.json — ${result.recommendations.length} recommendations`);
  log(`headline: ${result.keyInsight}`);
}

main().catch(e => { err('fatal:', e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * SBI CEO Lens — Monthly Strategic Recommendations
 * =================================================
 * Calls Claude Opus 4.7 with web search + extended thinking to research
 * the SBI competitive + market landscape and return 5-8 structured
 * strategic recommendations.
 *
 * Inputs
 *   - performance.json (current internal metrics — read for context so the
 *     model can ground advice in actual SBI numbers)
 *   - sales-data.json (pipeline aggregates by Job Type / Lead Source)
 *
 * Outputs
 *   - ceo-advice.json (structured recommendations + research scope)
 *
 * Cadence: monthly. Skips silently if existing ceo-advice.json is less
 * than 28 days old. Pass --force to override.
 *
 * Cost: ~$1-$3 per run (web search + extended thinking on Opus 4.7).
 *
 * Environment: ANTHROPIC_API_KEY
 *
 * Usage:
 *   node ceo-advice.js
 *   node ceo-advice.js --force
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname);
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const MODEL = 'claude-opus-4-7';
const STALE_DAYS = 28;
const FORCE = process.argv.includes('--force');

function log(...a) { console.log('[ceo]', ...a); }
function warn(...a) { console.warn('[ceo] WARN:', ...a); }
function err(...a) { console.error('[ceo] ERROR:', ...a); }

// ─────────────────────────────────────────────────────────────
// Skip logic — only run monthly
// ─────────────────────────────────────────────────────────────

function shouldSkip() {
  if (FORCE) return false;
  const p = path.join(REPO_ROOT, 'ceo-advice.json');
  if (!fs.existsSync(p)) return false;
  const ageMs = Date.now() - fs.statSync(p).mtimeMs;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays < STALE_DAYS) {
    log(`existing ceo-advice.json is ${ageDays.toFixed(1)}d old (<${STALE_DAYS}d). Skipping. Pass --force to override.`);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Internal context — what SBI looks like right now
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

  // Top job types by win rate (min 5 closed deals)
  const typesSummary = Object.entries(sales.byType || {})
    .filter(([k, v]) => k !== '(no type set)' && (v.won + v.lost) >= 5)
    .map(([k, v]) => ({
      type: k,
      wonCount: v.won,
      lostCount: v.lost,
      winRate: v.winRate,
      avgWonValue: v.avgWonValue,
      ambiguousCount: v.ambiguous || 0,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  const sourcesSummary = Object.entries(sales.byLeadSource || {})
    .filter(([k, v]) => k !== '(unknown)' && v.total >= 3)
    .map(([k, v]) => ({
      source: k,
      total: v.total,
      won: v.won,
      lost: v.lost,
      winRate: v.winRate,
      avgWonValue: v.avgWonValue,
    }))
    .sort((a, b) => (b.won || 0) - (a.won || 0));

  const archivedSummary = archived.map(j => ({
    name: j.name,
    type: j.type,
    revenueExGST: j.revenueExGST,
    actualMarginPct: j.actualMarginPct,
    plannedMarginPct: j.plannedMarginPct,
    buildCycleDays: j.buildCycleDays,
    profitPerBuildDay: j.profitPerBuildDay,
  }));

  const repeats = (sales.repeatClients || []).slice(0, 10).map(c => ({
    name: c.displayName, deals: c.dealCount, won: c.wonCount, totalWonValue: c.totalWonValue,
  }));

  return {
    businessName: 'Spoke Building & Interiors (SBI)',
    serviceArea: 'NSW Central Coast and Newcastle',
    primaryWork: 'Commercial fitouts (office, retail, hospitality), joinery (factory + install), residential joinery, design + drafting',
    teamSize: 'Small (~10-15 people including PM, factory, install, design, admin)',
    overallWinRate: sales.overallWinRate,
    overallAvgSalesCycleDays: sales.overallAvgSalesCycleDays,
    totalDeals: sales.totalDeals,
    wonCount: sales.wonCount,
    lostCount: sales.lostCount,
    ambiguousCount: sales.ambiguousCount,
    typesSummary,
    sourcesSummary,
    archivedSummary,
    repeatClients: repeats,
  };
}

// ─────────────────────────────────────────────────────────────
// Structured output schema (Claude will fill this via tool_use)
// ─────────────────────────────────────────────────────────────

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    monthCovered: { type: 'string', description: 'Month + year this brief covers, e.g. "June 2026"' },
    keyInsight: { type: 'string', description: 'One-sentence headline insight — the most important thing SBI should know about their market right now (max 30 words)' },
    recommendations: {
      type: 'array',
      minItems: 5,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Punchy title (max 12 words)' },
          category: {
            type: 'string',
            enum: ['Market Positioning', 'Sales Channel', 'Pricing', 'Operations', 'Talent', 'Compliance', 'Brand'],
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          horizon: {
            type: 'string',
            enum: ['this-quarter', '6-months', '12-months', 'strategic'],
            description: 'When SBI should act on this',
          },
          evidence: {
            type: 'string',
            description: '2-3 sentences with specific data points, competitor names, market figures. Cite numbers.',
          },
          sources: {
            type: 'array',
            description: '1-4 source URLs that informed this recommendation',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                title: { type: 'string', description: 'Short publisher + headline' },
              },
              required: ['url', 'title'],
            },
          },
          reasoning: {
            type: 'string',
            description: 'Why this matters for SBI specifically given their numbers (1-2 sentences)',
          },
          action: {
            type: 'string',
            description: 'Specific, concrete action — start with a verb. Max 25 words.',
          },
          impact: {
            type: 'string',
            description: 'What changes if SBI acts on this. Quantify if possible. Max 20 words.',
          },
        },
        required: ['title', 'category', 'confidence', 'horizon', 'evidence', 'sources', 'reasoning', 'action', 'impact'],
      },
    },
    researchScope: {
      type: 'object',
      properties: {
        competitorsFound: {
          type: 'array',
          description: 'Names of competitors discovered during research (5-12 names)',
          items: { type: 'string' },
        },
        trendsCovered: {
          type: 'array',
          description: 'Topics researched, e.g. "NSW commercial construction 2026 outlook", "BCA 2025 changes"',
          items: { type: 'string' },
        },
      },
      required: ['competitorsFound', 'trendsCovered'],
    },
  },
  required: ['monthCovered', 'keyInsight', 'recommendations', 'researchScope'],
};

// ─────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a strategic advisor playing the role of an experienced commercial-fitout CEO who has scaled multiple small-to-mid trade businesses in NSW Australia. You are advising Spoke Building & Interiors (SBI), a Central Coast / Newcastle commercial fitout + joinery business.

Your job is to give SBI's leadership team broad-ranging, externally-informed advice they would NOT see from looking at their own dashboard alone. Read the internal context provided, then use web search to research:

1. **Local competitors** — companies SBI competes against in NSW Central Coast (Gosford, Erina, Tuggerah, Woy Woy, The Entrance) and Newcastle (Newcastle CBD, Charlestown, Maitland). Identify 5-10 by searching for terms like "office fitout Central Coast", "commercial fitout Newcastle", "shop fitout Hunter NSW", "commercial joinery Newcastle". Note what they emphasise, who their typical clients are, their pricing signals if visible, any recent project announcements.

2. **NSW commercial construction outlook** — HIA, Master Builders, ABS data on the NSW non-residential construction outlook for 2026-2027. Hospitality fitout demand. Office space leasing trends post-WFH normalisation. Retail vacancy + fitout cycles.

3. **Regulatory / compliance shifts** — BCA / NCC changes coming through 2026-2027 (especially Class 5/6/9b for commercial spaces). NSW Design and Building Practitioners Act ongoing obligations. SafeWork NSW changes. Sustainability / energy-efficiency requirements that will affect commercial fitouts.

4. **Digital + SEO landscape** — Google search trends for fitout-related queries in NSW. Underserved keywords competitors aren't ranking for. Common pain points clients express on forums / reviews. Lead-channel benchmarks for fitout businesses (what % typically come from referral vs Google vs trade media).

5. **Pricing benchmarks** — typical $/m² rates for commercial office, retail, hospitality fitouts in NSW. Where SBI's deal sizes likely sit vs market.

6. **Talent + trade market** — Central Coast / Newcastle trade availability, wage pressure on cabinet makers, install crew, leading-hands. Any specialist trades in short supply that would constrain SBI's scaling.

Output 5-8 recommendations using the submit_recommendations tool. Each recommendation must:
- Be **specific to SBI given their actual numbers** (you have their win rates, lead sources, repeat clients, archived job metrics — use them)
- Cite **at least one source URL** from your web research
- Reference **at least one named competitor or market data point** for credibility
- End with a **concrete action** (start with a verb) and **quantified impact** where possible

Bias toward advice that is:
- **Counter-intuitive or non-obvious** (don't tell them their highest-win-rate type is good — they can see that themselves)
- **Externally informed** (about the market, competitors, regulation — not internal process tweaks)
- **Time-sensitive** (favour "act this quarter" over "consider in 2 years")

Avoid:
- Generic platitudes ("focus on quality", "build relationships")
- Restating their internal metrics back at them
- Recommendations they could have inferred from the dashboard alone

Treat this like a board-level briefing.`;

function buildUserMessage(ctx) {
  const lines = [
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Current internal context — SBI live numbers',
    '```json',
    JSON.stringify(ctx, null, 2),
    '```',
    '',
    'Research the NSW Central Coast + Newcastle commercial fitout market and produce 5-8 strategic recommendations using the submit_recommendations tool.',
    '',
    'Remember: I have already seen my own dashboard. Tell me what I cannot see from inside the business.',
  ];
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Claude API call with web search + structured output
// ─────────────────────────────────────────────────────────────

async function callClaude(ctx) {
  const tools = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 12 },
    {
      name: 'submit_recommendations',
      description: 'Submit the final 5-8 strategic recommendations after web research is complete. Call this exactly once.',
      input_schema: OUTPUT_SCHEMA,
    },
  ];

  const body = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools,
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: buildUserMessage(ctx) }],
  };

  log(`calling ${MODEL} with web search + structured output…`);
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
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude API ${res.status}: ${errBody.slice(0, 500)}`);
  }
  const data = await res.json();
  log(`response in ${elapsed}s · stop_reason: ${data.stop_reason} · input_tokens: ${data.usage.input_tokens} · output_tokens: ${data.usage.output_tokens}`);

  // Find the submit_recommendations tool_use block
  const submit = (data.content || []).find(c => c.type === 'tool_use' && c.name === 'submit_recommendations');
  if (!submit) {
    const textBlocks = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 1000);
    throw new Error('Claude did not call submit_recommendations. Last text: ' + textBlocks);
  }
  return { result: submit.input, usage: data.usage };
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    err('ANTHROPIC_API_KEY not set. CEO Lens skipped.');
    process.exit(0); // soft-fail — don't break the weekly cron
  }
  if (shouldSkip()) process.exit(0);

  const ctx = buildContext();
  log(`built context: ${ctx.totalDeals} deals, ${ctx.typesSummary.length} job types, ${ctx.sourcesSummary.length} lead sources, ${ctx.archivedSummary.length} archived jobs`);

  const { result, usage } = await callClaude(ctx);

  const out = {
    generated: new Date().toISOString(),
    model: MODEL,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    ...result,
  };

  fs.writeFileSync(path.join(REPO_ROOT, 'ceo-advice.json'), JSON.stringify(out, null, 2), 'utf8');
  log(`wrote ceo-advice.json — ${result.recommendations.length} recommendations`);
  log(`headline: ${result.keyInsight}`);
}

main().catch(e => { err('fatal:', e.message); process.exit(1); });

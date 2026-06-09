#!/usr/bin/env node
/**
 * Fetch Sales Pipeline Data
 * =========================
 * Reads the SBI Deals list (`900301389267`) and writes sales-data.json
 * with aggregates the performance page consumes:
 *
 *   - byType[jobType] → {won, lost, open, winRate, avgSalesCycleDays, avgDealValue}
 *   - repeatClients[] → clients with >1 deal (by normalized task-name prefix)
 *   - perTaskSalesCycle[taskId] → days from date_created to date_closed
 *     (used by performance.js to merge sales-cycle into per-archived-job rows)
 *
 * "Won" = status `closed won`.
 * "Lost" = status `done lost after proposal` or `declined_no proposal`.
 * Open  = anything else not in a terminal state.
 * (Status names updated for the 2026-06 Deals-list status rename. The old
 *  `done lost` / `declined to quote` / `done complete` statuses no longer exist.)
 *
 * Environment: CLICKUP_API_TOKEN
 *
 * Usage: node fetch-sales-data.js
 */

const fs = require('fs');
const path = require('path');

const DEALS_LIST = '900301389267';
const JOB_TYPE_FIELD = 'c73099fb-6ef6-45ec-a279-41824e1807ad';
const LEAD_SOURCE_FIELD = 'f54eea38-bbc0-4336-b61e-5fc85b463658';
const DEAL_VALUE_FIELD = 'e54326a0-d0f2-4912-b4d4-ac9872ee979f'; // 04. Deal Value (INCL GST)
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const TOKEN = process.env.CLICKUP_API_TOKEN || process.env.CLICKUP_TOKEN;
const REPO_ROOT = path.resolve(__dirname);

// Terminal statuses, per the 2026-06 Deals-list status rename.
//   WON  = `closed won` (type=done)
//   LOST = `done lost after proposal` (type=closed) + `declined_no proposal` (type=done).
//          These replace the old `done lost` / `declined to quote`. The rename is what
//          broke the win-rate maths — losses fell through to "open", giving a 100% win rate.
const WON_STATUSES = new Set(['closed won']);
const LOST_STATUSES = new Set(['done lost after proposal', 'declined_no proposal']);
// `done complete` was a legacy generic "deal closed" status, fully migrated during the
// rename (0 deals remain in it). Kept here so that if any straggler reappears it surfaces
// as "outcome unknown" rather than silently skewing the win-rate.
const AMBIGUOUS_STATUSES = new Set(['done complete']);

function log(...a) { console.log('[sales]', ...a); }
function warn(...a) { console.warn('[sales] WARN:', ...a); }

async function fetchPage(page) {
  const url = `${CLICKUP_API}/list/${DEALS_LIST}/task?page=${page}&include_closed=true&subtasks=false&order_by=created`;
  const res = await fetch(url, { headers: { Authorization: TOKEN } });
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchAllDeals() {
  const all = [];
  let page = 0;
  while (true) {
    const d = await fetchPage(page);
    all.push(...d.tasks);
    log(`page ${page}: ${d.tasks.length} tasks`);
    if (d.last_page || d.tasks.length < 100) break;
    page++;
    if (page > 30) { warn('aborting pagination at 30 pages'); break; }
  }
  return all;
}

function getCustomField(task, fieldId) {
  return (task.custom_fields || []).find(c => c.id === fieldId);
}

function getJobTypeLabels(task) {
  const cf = getCustomField(task, JOB_TYPE_FIELD);
  if (!cf || !cf.value || !Array.isArray(cf.value) || !cf.type_config) return [];
  const opts = (cf.type_config.options || []);
  const byId = {};
  opts.forEach(o => { byId[o.id] = o.label || o.name; });
  return cf.value.map(id => byId[id]).filter(Boolean);
}

function getLeadSource(task) {
  const cf = getCustomField(task, LEAD_SOURCE_FIELD);
  if (!cf || cf.value === null || cf.value === undefined || cf.value === '') return null;
  // drop_down values can be either the option id (string) or the option index (number)
  const opts = (cf.type_config && cf.type_config.options) || [];
  // Try id match
  let opt = opts.find(o => o.id === cf.value);
  // Try orderindex match (number)
  if (!opt && typeof cf.value === 'number') opt = opts[cf.value] || opts.find(o => o.orderindex === cf.value);
  return opt ? (opt.name || opt.label) : null;
}

function getDealValue(task) {
  const cf = getCustomField(task, DEAL_VALUE_FIELD);
  return cf && cf.value ? parseFloat(cf.value) : null;
}

function classify(task) {
  const status = (task.status && task.status.status || '').toLowerCase();
  if (WON_STATUSES.has(status)) return 'won';
  if (LOST_STATUSES.has(status)) return 'lost';
  if (AMBIGUOUS_STATUSES.has(status)) return 'ambiguous';
  return 'open';
}

function normalizeClientName(taskName) {
  // Strip common suffixes / job-type tags so "Mingara Club - Desk Supply"
  // and "Mingara Club — Small Office Fitout" collide on the same client.
  return (taskName || '')
    .toLowerCase()
    .split(/[-–—]|\s\(|\s—|\sjoinery\b|\sfitout\b|\sresidential\b|\sdesign\b/)[0]
    .replace(/[^a-z0-9 &]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function daysBetween(msA, msB) {
  if (!msA || !msB) return null;
  return Math.round((parseInt(msB) - parseInt(msA)) / 86400000);
}

function mean(arr) {
  const vals = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function main() {
  if (!TOKEN) { console.error('CLICKUP_API_TOKEN not set'); process.exit(2); }

  log('fetching deals list', DEALS_LIST);
  const tasks = await fetchAllDeals();
  log(`total deals fetched: ${tasks.length}`);

  // Per-deal summary
  const deals = tasks.map(t => {
    const types = getJobTypeLabels(t);
    const outcome = classify(t);
    // ClickUp populates `date_closed` only for statuses with type=closed.
    // Won/lost deals have type=done, which populates `date_done` instead.
    // Prefer date_done; fall back to date_closed for the few done-complete deals.
    const closedDate = t.date_done ? parseInt(t.date_done)
                       : (t.date_closed ? parseInt(t.date_closed) : null);
    const createdDate = t.date_created ? parseInt(t.date_created) : null;
    return {
      id: t.id,
      name: t.name,
      url: t.url,
      status: t.status && t.status.status,
      outcome,
      types,
      leadSource: getLeadSource(t),
      dealValue: getDealValue(t),
      createdDate,
      closedDate,
      salesCycleDays: outcome !== 'open' ? daysBetween(createdDate, closedDate) : null,
      clientKey: normalizeClientName(t.name),
    };
  });

  // Aggregate by job type
  const byType = {};
  const ALL_TYPES = new Set();
  deals.forEach(d => d.types.forEach(t => ALL_TYPES.add(t)));
  // Also include an "(no type set)" bucket so we don't lose the long tail of
  // deals that never had a Job Type label applied.
  ALL_TYPES.add('(no type set)');

  for (const type of ALL_TYPES) {
    const matching = type === '(no type set)'
      ? deals.filter(d => d.types.length === 0)
      : deals.filter(d => d.types.includes(type));
    const won = matching.filter(d => d.outcome === 'won');
    const lost = matching.filter(d => d.outcome === 'lost');
    const open = matching.filter(d => d.outcome === 'open');
    const ambiguous = matching.filter(d => d.outcome === 'ambiguous');
    const closed = won.length + lost.length;
    byType[type] = {
      total: matching.length,
      won: won.length,
      lost: lost.length,
      open: open.length,
      ambiguous: ambiguous.length,
      winRate: closed > 0 ? won.length / closed : null,
      avgSalesCycleDays: mean(won.map(d => d.salesCycleDays).filter(Boolean)),
      avgWonValue: mean(won.map(d => d.dealValue).filter(Boolean)),
      totalWonValue: won.reduce((s, d) => s + (d.dealValue || 0), 0),
    };
  }

  // Aggregate by lead source
  const byLeadSource = {};
  const ALL_SOURCES = new Set(deals.map(d => d.leadSource || '(unknown)'));
  for (const src of ALL_SOURCES) {
    const matching = deals.filter(d => (d.leadSource || '(unknown)') === src);
    const won = matching.filter(d => d.outcome === 'won');
    const lost = matching.filter(d => d.outcome === 'lost');
    const open = matching.filter(d => d.outcome === 'open');
    const closed = won.length + lost.length;
    const ambiguous = matching.filter(d => d.outcome === 'ambiguous');
    byLeadSource[src] = {
      total: matching.length,
      won: won.length,
      lost: lost.length,
      open: open.length,
      ambiguous: ambiguous.length,
      winRate: closed > 0 ? won.length / closed : null,
      avgSalesCycleDays: mean(won.map(d => d.salesCycleDays).filter(Boolean)),
      avgWonValue: mean(won.map(d => d.dealValue).filter(Boolean)),
      totalWonValue: won.reduce((s, d) => s + (d.dealValue || 0), 0),
    };
  }

  // Repeat clients (>1 deal under same normalized name)
  const byClient = {};
  deals.forEach(d => {
    if (!d.clientKey) return;
    (byClient[d.clientKey] = byClient[d.clientKey] || []).push(d);
  });
  const repeatClients = Object.entries(byClient)
    .filter(([k, arr]) => arr.length > 1)
    .map(([k, arr]) => ({
      clientKey: k,
      displayName: arr[0].name,
      dealCount: arr.length,
      wonCount: arr.filter(d => d.outcome === 'won').length,
      lostCount: arr.filter(d => d.outcome === 'lost').length,
      openCount: arr.filter(d => d.outcome === 'open').length,
      totalWonValue: arr.filter(d => d.outcome === 'won').reduce((s, d) => s + (d.dealValue || 0), 0),
      deals: arr.map(d => ({ id: d.id, name: d.name, status: d.status, outcome: d.outcome, dealValue: d.dealValue })),
    }))
    .sort((a, b) => b.dealCount - a.dealCount);

  // Per-task sales cycle (for merge into performance.js)
  const perTaskSalesCycle = {};
  deals.forEach(d => { if (d.salesCycleDays !== null) perTaskSalesCycle[d.id] = d.salesCycleDays; });

  // Status breakdown
  const byStatus = {};
  deals.forEach(d => { byStatus[d.status] = (byStatus[d.status] || 0) + 1; });

  // Minimal raw deals array for client-side year-filter re-aggregation
  // on the performance page. Includes only the fields needed to recompute
  // byType / byLeadSource / repeatClients aggregates.
  const dealsForFilter = deals.map(d => ({
    id: d.id,
    name: d.name,
    types: d.types,
    leadSource: d.leadSource,
    outcome: d.outcome,
    dealValue: d.dealValue,
    salesCycleDays: d.salesCycleDays,
    closeYear: d.closedDate ? new Date(d.closedDate).getFullYear() : null,
    createYear: d.createdDate ? new Date(d.createdDate).getFullYear() : null,
    clientKey: d.clientKey,
  }));

  const out = {
    generated: new Date().toISOString(),
    totalDeals: deals.length,
    wonCount: deals.filter(d => d.outcome === 'won').length,
    lostCount: deals.filter(d => d.outcome === 'lost').length,
    openCount: deals.filter(d => d.outcome === 'open').length,
    ambiguousCount: deals.filter(d => d.outcome === 'ambiguous').length,
    overallWinRate: (() => {
      const w = deals.filter(d => d.outcome === 'won').length;
      const l = deals.filter(d => d.outcome === 'lost').length;
      return w + l > 0 ? w / (w + l) : null;
    })(),
    overallAvgSalesCycleDays: mean(deals.filter(d => d.outcome === 'won').map(d => d.salesCycleDays).filter(Boolean)),
    byStatus,
    byType,
    byLeadSource,
    repeatClients,
    perTaskSalesCycle,
    deals: dealsForFilter,
  };

  fs.writeFileSync(path.join(REPO_ROOT, 'sales-data.json'), JSON.stringify(out, null, 2), 'utf8');
  log(`wrote sales-data.json — ${deals.length} deals, ${out.wonCount} won, ${out.lostCount} lost, ${out.openCount} open`);
  log(`overall win rate: ${out.overallWinRate ? (out.overallWinRate * 100).toFixed(1) + '%' : 'n/a'}, avg sales cycle (won): ${out.overallAvgSalesCycleDays ? Math.round(out.overallAvgSalesCycleDays) + 'd' : 'n/a'}`);
  log(`repeat clients: ${repeatClients.length}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

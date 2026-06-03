#!/usr/bin/env node
/**
 * SBI Project Performance Builder
 * ================================
 * Scans every dashboard folder in this repo, extracts the project-data
 * JSON block, derives planned vs actual profitability + cycle-time metrics,
 * and writes:
 *   - performance.json  (machine-readable rollup)
 *   - performance.html  (sortable table + per-Job-Type rollups + filters)
 *
 * Idempotent. Reads from existing dashboard JSON only — no ClickUp calls.
 * Sales-cycle (first-contact → won) is NOT computed in v1 (needs deal-task
 * fetch). Build cycle = Sold date → latest done admin milestone.
 *
 * Usage:
 *   node performance.js
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname);

function log(...a) { console.log('[perf]', ...a); }
function warn(...a) { console.warn('[perf] WARN:', ...a); }

function extractProjectData(html) {
  const m = html.match(
    /<script type="application\/json" id="project-data">([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); }
  catch (e) { warn('JSON parse failed:', e.message); return null; }
}

function parseDateLoose(s) {
  if (!s) return null;
  // ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s + 'T00:00:00');
    return isNaN(d) ? null : d;
  }
  // "12 Jun 2025" / "23 Mar 2026" — must have a 4-digit year, else JS Date()
  // silently defaults the year to 2001 (the parser's epoch fallback) and
  // produces wildly wrong cycle-time deltas.
  if (!/\b(19|20)\d{2}\b/.test(s)) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = a instanceof Date ? a : parseDateLoose(a);
  const db = b instanceof Date ? b : parseDateLoose(b);
  if (!da || !db) return null;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

function getStream(streams, id) {
  return (streams || []).find(s => s.id === id) || null;
}

function computePerf(slug, data, archived) {
  const project = data.project || {};
  const claims = data.claims || [];
  const variationsApproved = (data.variations || []).filter(v => v.approved);
  const budget = data.budget || {};
  const streams = (data.lifecycle && data.lifecycle.streams) || [];

  const claimsTotal = claims.reduce((s, c) => s + (c.amount || 0), 0);
  const varsTotal = variationsApproved.reduce((s, v) => s + (v.amount || 0), 0);
  const revenueExGST = (claimsTotal + varsTotal) / 1.1;

  const plannedCost = budget.totalBudget || 0;
  const actualCost = budget.totalActual || 0;

  const labourBudget = (budget.labour || []).reduce((s, l) => s + (l.budget || 0), 0);
  const labourActual = (budget.labour || []).reduce((s, l) => s + (l.actual || 0), 0);

  // Paid revenue = claims with workflow Invoice Paid
  const paidRevenue = claims.concat(variationsApproved)
    .filter(c => c.workflow === 'Invoice Paid')
    .reduce((s, c) => s + (c.amount || 0), 0) / 1.1;

  const admin = getStream(streams, 'admin');
  const site  = getStream(streams, 'site');

  // Sold date — prefer project.dateSold (deal close), fall back to lifecycle Sold milestone
  const soldFromProject = parseDateLoose(project.dateSold);
  const soldFromLifecycle = admin
    ? (admin.milestones.find(m => m.name === 'Sold') || {}).date
    : null;
  const soldDate = soldFromProject || parseDateLoose(soldFromLifecycle);

  // Completion date = latest "done" admin milestone date (last paid invoice)
  let completedDate = null;
  if (admin) {
    const doneDates = admin.milestones
      .filter(m => m.status === 'done' && m.date)
      .map(m => parseDateLoose(m.date))
      .filter(Boolean)
      .sort((a, b) => a - b);
    if (doneDates.length) completedDate = doneDates[doneDates.length - 1];
  }

  // Site dates — first and last milestone in site stream
  let siteStart = null, siteEnd = null;
  if (site && site.milestones.length) {
    const dates = site.milestones
      .map(m => parseDateLoose(m.date))
      .filter(Boolean)
      .sort((a, b) => a - b);
    if (dates.length) {
      siteStart = dates[0];
      siteEnd = dates[dates.length - 1];
    }
  }

  const buildCycleDays = daysBetween(soldDate, completedDate);
  const siteDays = daysBetween(siteStart, siteEnd);

  const plannedMarginAmt = revenueExGST - plannedCost;
  const actualMarginAmt = revenueExGST - actualCost;
  const plannedMarginPct = revenueExGST > 0 ? plannedMarginAmt / revenueExGST : null;
  const actualMarginPct = revenueExGST > 0 ? actualMarginAmt / revenueExGST : null;

  const profitPerBuildDay = (actualMarginAmt > 0 && buildCycleDays && buildCycleDays > 0)
    ? actualMarginAmt / buildCycleDays
    : null;
  const revenuePerSiteDay = (revenueExGST > 0 && siteDays && siteDays > 0)
    ? revenueExGST / siteDays
    : null;

  return {
    slug,
    archived,
    jobNumber: project.jobNumber || '',
    name: project.name || slug,
    type: project.type || '',
    pm: (project.pm || '').trim(),
    client: project.client || '',
    soldDate: soldDate ? soldDate.toISOString().slice(0, 10) : null,
    completedDate: completedDate ? completedDate.toISOString().slice(0, 10) : null,
    siteStart: siteStart ? siteStart.toISOString().slice(0, 10) : null,
    siteEnd: siteEnd ? siteEnd.toISOString().slice(0, 10) : null,
    buildCycleDays,
    siteDays,
    revenueExGST: Math.round(revenueExGST),
    paidRevenueExGST: Math.round(paidRevenue),
    plannedCost: Math.round(plannedCost),
    actualCost: Math.round(actualCost),
    plannedMarginAmt: Math.round(plannedMarginAmt),
    actualMarginAmt: Math.round(actualMarginAmt),
    plannedMarginPct: plannedMarginPct === null ? null : Math.round(plannedMarginPct * 1000) / 10,
    actualMarginPct: actualMarginPct === null ? null : Math.round(actualMarginPct * 1000) / 10,
    labourBudget: Math.round(labourBudget),
    labourActual: Math.round(labourActual),
    labourOverrun: Math.round(labourActual - labourBudget),
    variationCount: variationsApproved.length,
    variationValueExGST: Math.round(varsTotal / 1.1),
    profitPerBuildDay: profitPerBuildDay === null ? null : Math.round(profitPerBuildDay),
    revenuePerSiteDay: revenuePerSiteDay === null ? null : Math.round(revenuePerSiteDay),
  };
}

function discoverArchivedSlugs(rootHtml) {
  const m = rootHtml.match(/<!-- DASHBOARDS:ARCHIVE:BEGIN -->([\s\S]*?)<!-- DASHBOARDS:ARCHIVE:END -->/);
  const slugs = new Set();
  if (!m) return slugs;
  const re = /data-slug="([^"]+)"/g;
  let mm; while ((mm = re.exec(m[1]))) slugs.add(mm[1]);
  return slugs;
}

function loadSalesData() {
  const p = path.join(REPO_ROOT, 'sales-data.json');
  if (!fs.existsSync(p)) {
    warn('sales-data.json not present — run `node fetch-sales-data.js` first for sales-cycle + pipeline data');
    return null;
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { warn('failed to parse sales-data.json:', e.message); return null; }
}

function loadCeoAdvice() {
  const p = path.join(REPO_ROOT, 'ceo-advice.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { warn('failed to parse ceo-advice.json:', e.message); return null; }
}

function extractTaskId(url) {
  if (!url) return null;
  const m = url.match(/\/t\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

function main() {
  const rootHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  const archivedSlugs = discoverArchivedSlugs(rootHtml);
  const salesData = loadSalesData();
  const ceoAdvice = loadCeoAdvice();

  const entries = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => fs.existsSync(path.join(REPO_ROOT, name, 'index.html')));

  const jobs = [];
  for (const slug of entries) {
    const html = fs.readFileSync(path.join(REPO_ROOT, slug, 'index.html'), 'utf8');
    const data = extractProjectData(html);
    if (!data || !data.project) {
      warn(`${slug}: no project-data block, skipping`);
      continue;
    }
    const job = computePerf(slug, data, archivedSlugs.has(slug));

    // Merge sales-cycle days (created → won) if we can match this project's
    // sales task to the Deals list via the salesTaskUrl on project-data.
    const taskId = extractTaskId(data.project && data.project.salesTaskUrl);
    if (taskId && salesData && salesData.perTaskSalesCycle && salesData.perTaskSalesCycle[taskId] !== undefined) {
      job.salesCycleDays = salesData.perTaskSalesCycle[taskId];
    } else {
      job.salesCycleDays = null;
    }
    job.variationPctOfContract = job.revenueExGST > 0
      ? Math.round((job.variationValueExGST / job.revenueExGST) * 1000) / 10
      : null;

    jobs.push(job);
  }

  jobs.sort((a, b) => (b.jobNumber || '').localeCompare(a.jobNumber || ''));

  const out = {
    generated: new Date().toISOString(),
    jobCount: jobs.length,
    archivedCount: jobs.filter(j => j.archived).length,
    activeCount: jobs.filter(j => !j.archived).length,
    jobs,
    sales: salesData,
    ceo: ceoAdvice,
  };

  fs.writeFileSync(
    path.join(REPO_ROOT, 'performance.json'),
    JSON.stringify(out, null, 2),
    'utf8'
  );
  log(`Wrote performance.json — ${jobs.length} jobs (${out.archivedCount} archived, ${out.activeCount} active)`);

  const html = renderHtml(out);
  fs.writeFileSync(path.join(REPO_ROOT, 'performance.html'), html, 'utf8');
  log(`Wrote performance.html`);
}

function renderHtml(data) {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SBI Project Performance</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
*{box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#0f2540;color:#e6eef7;margin:0;padding:32px;min-height:100vh}
h1{font-size:24px;margin:0 0 4px}
.sub{color:#7fa8cc;font-size:13px;margin-bottom:6px}
.crumb{font-size:12px;color:#7fa8cc;margin-bottom:24px}
.crumb a{color:#7fa8cc}
.banner{background:#1a3a5c;border-left:3px solid #d97706;border-radius:6px;padding:12px 16px;margin-bottom:24px;font-size:12px;color:#cfdcea;line-height:1.55}
.banner b{color:#fff}

.controls{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;align-items:center}
.controls .group{display:flex;gap:0;border:1px solid #2a4a6c;border-radius:6px;overflow:hidden}
.controls .group span{font-size:11px;color:#7fa8cc;text-transform:uppercase;letter-spacing:.5px;padding:8px 12px;border-right:1px solid #2a4a6c;background:#0c1e34}
.controls button{background:#1a3a5c;border:none;color:#e6eef7;padding:8px 14px;cursor:pointer;font-size:12px;border-right:1px solid #2a4a6c;font-family:inherit}
.controls button:last-child{border-right:none}
.controls button.on{background:#1d4ed8;color:#fff;font-weight:600}
.controls button:hover{background:#1e4470}

.rollups{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:24px}
.roll{background:#1a3a5c;border:1px solid #2a4a6c;border-radius:10px;padding:16px 18px}
.roll .label{font-size:11px;color:#7fa8cc;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.roll .big{font-size:22px;font-weight:700;color:#fff;margin-bottom:4px}
.roll .stats{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:12px;color:#cfdcea;margin-top:10px}
.roll .stats div{display:flex;justify-content:space-between}
.roll .stats span:last-child{color:#fff;font-weight:600}
.roll .ok{color:#22c55e}
.roll .warn{color:#f59e0b}
.roll .bad{color:#ef4444}

table{width:100%;border-collapse:collapse;background:#0c1e34;border:1px solid #1f3a5c;border-radius:8px;overflow:hidden;font-size:12px}
th{text-align:left;padding:11px 10px;background:#13294a;color:#7fa8cc;font-weight:600;text-transform:uppercase;letter-spacing:.5px;font-size:10px;border-bottom:1px solid #1f3a5c;white-space:nowrap;cursor:pointer;user-select:none;position:sticky;top:0}
th:hover{background:#1a3258;color:#fff}
th.sort-asc::after{content:" ▲";color:#1d4ed8}
th.sort-desc::after{content:" ▼";color:#1d4ed8}
th.r,td.r{text-align:right}
td{padding:9px 10px;border-bottom:1px solid #15294a;color:#e6eef7;white-space:nowrap}
tr:hover td{background:#13294a}
tr.archived td{opacity:.7}
tr.archived td a{color:#7fa8cc}
.name{max-width:300px;white-space:normal;line-height:1.3}
.name a{color:#fff;text-decoration:none}
.name a:hover{color:#7fa8cc;text-decoration:underline}
.chip{display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;background:#1d4ed8;color:#fff}
.chip.joinery{background:#7c3aed}
.chip.design{background:#0891b2}
.chip.residential{background:#16a34a}
.chip.build{background:#1d4ed8}
.chip.do-charge{background:#d97706}
.chip.cert-design{background:#0891b2}
.pos{color:#22c55e;font-weight:600}
.neg{color:#ef4444;font-weight:600}
.muted{color:#4a7a9c}
.gen{font-size:11px;color:#4a7a9c;margin-top:18px;text-align:right}

.section-h{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#7fa8cc;margin:36px 0 14px;padding-bottom:8px;border-bottom:1px solid #1f3a5c}
.pipeline{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px}
.pipe-card{background:#0c1e34;border:1px solid #1f3a5c;border-radius:10px;padding:18px 20px}
.pipe-card h3{font-size:12px;color:#7fa8cc;text-transform:uppercase;letter-spacing:.8px;margin:0 0 12px;font-weight:600}
.pipe-card table{margin:0;border-radius:0;border:none;background:transparent}
.pipe-card th{background:transparent;border-bottom:1px solid #1f3a5c;padding:6px 8px;font-size:9px;cursor:default}
.pipe-card th:hover{background:transparent;color:#7fa8cc}
.pipe-card td{padding:7px 8px;border-bottom:1px solid #15294a;font-size:12px}
.pipe-card .winbar{display:inline-block;height:8px;background:#1d4ed8;border-radius:4px;vertical-align:middle;margin-right:6px}
.pipe-card .winbar.lo{background:#ef4444}
.pipe-card .winbar.mid{background:#f59e0b}
.pipe-card .winbar.hi{background:#22c55e}
.pipe-overall{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:14px}
.pipe-overall .stat{background:#13294a;border-left:3px solid #1d4ed8;padding:12px 14px;border-radius:6px}
.pipe-overall .stat .v{font-size:22px;font-weight:700;color:#fff}
.pipe-overall .stat .l{font-size:11px;color:#7fa8cc;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.repeat-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.repeat-chip{background:#13294a;border:1px solid #1f3a5c;border-radius:6px;padding:8px 10px;font-size:11px;color:#cfdcea}
.repeat-chip b{display:block;color:#fff;font-size:13px;margin-bottom:3px}
.discipline{background:#3a1a1a;border-left:3px solid #ef4444;border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#fecaca;line-height:1.5}
.discipline b{color:#fff}

.dq-card{background:linear-gradient(135deg,#1a3a5c 0%,#234e7b 100%);border:1px solid #3a6a9c;border-left:4px solid #22c55e;border-radius:10px;padding:18px 22px;margin:24px 0}
.dq-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:12px;margin-bottom:6px}
.dq-title{font-size:16px;font-weight:700;color:#fff;margin:0}
.dq-meta{font-size:11px;color:#cfdcea}
.dq-intro{font-size:12px;color:#cfdcea;line-height:1.5;margin:0 0 16px;max-width:780px}
.dq-list{display:grid;gap:10px}
.dq-action{background:rgba(0,0,0,.22);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:12px 14px;display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:start}
.dq-action.sev-high{border-left:3px solid #ef4444}
.dq-action.sev-med{border-left:3px solid #f59e0b}
.dq-action.sev-low{border-left:3px solid #22c55e}
.dq-action.sev-info{border-left:3px solid #7fa8cc}
.dq-count{font-size:24px;font-weight:700;color:#fff;line-height:1;min-width:50px;text-align:center;padding-top:2px}
.dq-count.zero{color:#22c55e;font-size:18px}
.dq-body .t{font-size:13px;font-weight:600;color:#fff;margin:0 0 4px}
.dq-body .d{font-size:11px;color:#cfdcea;line-height:1.5;margin:0 0 6px}
.dq-body .a{font-size:11px;color:#fbbf24;font-weight:600;line-height:1.4}
.dq-body .a:before{content:"→ "}
.dq-right{text-align:right;min-width:90px}
.dq-owner{display:inline-block;background:#1d4ed8;color:#fff;padding:3px 9px;border-radius:10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.dq-owner.gail{background:#7c3aed}
.dq-owner.michael{background:#0891b2}
.dq-owner.chadd{background:#d97706}
.dq-owner.team{background:#16a34a}
.dq-impact{font-size:10px;color:#7fa8cc;margin-top:4px;display:block}
.dq-foot{font-size:11px;color:#cfdcea;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1);line-height:1.5}
.dq-foot b{color:#fff}

.ceo-card{background:linear-gradient(135deg,#2a1f3d 0%,#3d2a5c 100%);border:1px solid #5a3a8c;border-left:4px solid #a78bfa;border-radius:10px;padding:20px 24px;margin:24px 0}
.ceo-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:12px;margin-bottom:6px}
.ceo-title{font-size:16px;font-weight:700;color:#fff;margin:0}
.ceo-meta{font-size:11px;color:#cfdcea}
.ceo-headline{background:rgba(0,0,0,.25);border-left:3px solid #fbbf24;padding:12px 16px;border-radius:6px;margin:14px 0 18px;font-size:14px;color:#fef3c7;line-height:1.5;font-style:italic}
.ceo-headline b{color:#fff;font-style:normal}
.ceo-list{display:grid;gap:14px}
.ceo-rec{background:rgba(0,0,0,.22);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:16px 18px}
.ceo-rec-top{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center}
.ceo-rec h4{font-size:14px;font-weight:700;color:#fff;margin:0 0 10px;line-height:1.35}
.ceo-chip{display:inline-block;padding:3px 9px;border-radius:10px;font-size:10px;font-weight:600;letter-spacing:.3px;text-transform:uppercase}
.ceo-chip.cat{background:#5b21b6;color:#fff}
.ceo-chip.conf-high{background:#15803d;color:#fff}
.ceo-chip.conf-medium{background:#a16207;color:#fff}
.ceo-chip.conf-low{background:#525252;color:#fff}
.ceo-chip.hor{background:#1e3a8a;color:#fff}
.ceo-rec .ev{font-size:12px;color:#e9d5ff;line-height:1.55;margin:0 0 8px}
.ceo-rec .rs{font-size:12px;color:#cfdcea;line-height:1.55;margin:0 0 10px;padding-left:10px;border-left:2px solid rgba(255,255,255,.15)}
.ceo-rec .act{font-size:12px;color:#fbbf24;font-weight:600;line-height:1.45;margin-bottom:6px}
.ceo-rec .act:before{content:"→ Action: "}
.ceo-rec .imp{font-size:11px;color:#cfdcea;line-height:1.4}
.ceo-rec .imp:before{content:"⚡ Impact: ";color:#a78bfa;font-weight:600}
.ceo-rec .sources{font-size:10px;color:#a78bfa;margin-top:10px;padding-top:8px;border-top:1px dashed rgba(255,255,255,.1)}
.ceo-rec .sources a{color:#c4b5fd;text-decoration:none}
.ceo-rec .sources a:hover{text-decoration:underline}
.ceo-scope{font-size:11px;color:#cfdcea;margin-top:16px;padding:10px 14px;background:rgba(0,0,0,.18);border-radius:6px;line-height:1.5}
.ceo-scope b{color:#fff}
.ceo-empty{background:rgba(0,0,0,.22);border:1px dashed rgba(255,255,255,.15);border-radius:8px;padding:18px 22px;font-size:12px;color:#cfdcea;line-height:1.6}
.ceo-empty b{color:#fff}
.ceo-empty code{background:rgba(0,0,0,.4);padding:2px 6px;border-radius:3px;font-family:Consolas,monospace;font-size:11px;color:#fbbf24}

@media (max-width:700px){.dq-action{grid-template-columns:1fr}.dq-count{text-align:left}.dq-right{text-align:left}}

@media (max-width:1100px){body{padding:16px}.rollups{grid-template-columns:1fr 1fr}.pipeline{grid-template-columns:1fr}}
@media (max-width:700px){.rollups{grid-template-columns:1fr}.controls{font-size:11px}}
</style>
</head>
<body>
<div class="crumb"><a href="./">← All dashboards</a></div>
<h1>📊 Project Performance Review</h1>
<div class="sub">Profitability + cycle-time across SBI projects. Click any column header to sort.</div>

<div class="banner">
<b>Three lenses on each job.</b> <b>Plan margin</b> = contract value ex-GST minus budgeted cost (always honest because it's our forecast). <b>Actual margin</b> uses the actual-PO column from 08 Procurement — only reliable if procurement actuals are kept current; suspiciously-high actual margins usually mean labour costs weren't reconciled rather than the job killing it. <b>Sales pipeline</b> below shows win-rate, lead-source, and repeat-client patterns for the entire Deals list, not just the archived jobs in the table.<br>
<b>Definitions:</b> Build cycle = sold → last paid invoice. Sales cycle = deal created → won. $/day = actual margin ÷ build days. Site days = sparse (only first/last lifecycle.site milestones), to be improved in v2.
</div>

<div class="controls">
  <div class="group" id="filter-archived"><span>Show</span>
    <button data-v="archived" class="on">Archived</button>
    <button data-v="active">Active</button>
    <button data-v="all">All</button>
  </div>
  <div class="group" id="filter-type"><span>Type</span>
    <button data-v="all" class="on">All</button>
  </div>
  <div class="group" id="filter-pm"><span>PM</span>
    <button data-v="all" class="on">All</button>
  </div>
  <div class="group" id="filter-year"><span>Year</span>
    <button data-v="all" class="on">All</button>
  </div>
</div>

<div class="rollups" id="rollups"></div>

<div id="sales-pipeline"></div>

<h2 class="section-h" id="per-job-h">Per-job Performance</h2>
<table>
<thead><tr id="thead-row"></tr></thead>
<tbody id="tbody"></tbody>
</table>

<div class="gen" id="gen"></div>

<script>
const DATA = ${payload};

const COLS = [
  { key:'jobNumber', label:'Job #', type:'text' },
  { key:'name', label:'Name', type:'name' },
  { key:'type', label:'Type', type:'chip' },
  { key:'pm', label:'PM', type:'text' },
  { key:'soldDate', label:'Sold', type:'date' },
  { key:'completedDate', label:'Last $', type:'date' },
  { key:'buildCycleDays', label:'Build d', type:'num' },
  { key:'siteDays', label:'Site d', type:'num' },
  { key:'revenueExGST', label:'Revenue ex', type:'money' },
  { key:'plannedCost', label:'Plan cost', type:'money' },
  { key:'plannedMarginAmt', label:'Plan $', type:'money-signed' },
  { key:'plannedMarginPct', label:'Plan %', type:'pct-signed' },
  { key:'actualCost', label:'Act cost', type:'money' },
  { key:'actualMarginAmt', label:'Act $', type:'money-signed' },
  { key:'actualMarginPct', label:'Act %', type:'pct-signed' },
  { key:'profitPerBuildDay', label:'$/day', type:'money' },
  { key:'labourOverrun', label:'Labour Δ', type:'money-signed-inverse' },
  { key:'salesCycleDays', label:'Sales d', type:'num' },
  { key:'variationCount', label:'V#', type:'num' },
  { key:'variationPctOfContract', label:'V %', type:'pct' },
];

let sortKey = 'jobNumber';
let sortDir = -1;
let filters = { archived: 'archived', type: 'all', pm: 'all', year: 'all' };

function jobYear(j) {
  if (!j.soldDate) return null;
  return parseInt(j.soldDate.slice(0, 4));
}

function fmt(v, type) {
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
  if (type === 'money') return '$' + Math.round(v).toLocaleString();
  if (type === 'money-signed') {
    const sign = v >= 0 ? '' : '-';
    const cls = v >= 0 ? 'pos' : 'neg';
    return '<span class="' + cls + '">' + sign + '$' + Math.abs(Math.round(v)).toLocaleString() + '</span>';
  }
  if (type === 'money-signed-inverse') {
    // labour overrun: positive (over budget) is bad; negative (under) is good
    const cls = v > 0 ? 'neg' : 'pos';
    const sign = v > 0 ? '+' : (v < 0 ? '-' : '');
    return '<span class="' + cls + '">' + sign + '$' + Math.abs(Math.round(v)).toLocaleString() + '</span>';
  }
  if (type === 'pct-signed') {
    const cls = v >= 20 ? 'pos' : (v >= 0 ? '' : 'neg');
    return '<span class="' + cls + '">' + (v >= 0 ? '' : '') + v.toFixed(1) + '%</span>';
  }
  if (type === 'pct') return v.toFixed(1) + '%';
  if (type === 'num') return v.toLocaleString();
  if (type === 'date') return v;
  if (type === 'chip') {
    const slug = (v || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
    return '<span class="chip ' + slug + '">' + v + '</span>';
  }
  return String(v);
}

function buildTypeButtons() {
  const types = Array.from(new Set(DATA.jobs.map(j => j.type).filter(Boolean))).sort();
  const grp = document.getElementById('filter-type');
  types.forEach(t => {
    const b = document.createElement('button');
    b.dataset.v = t;
    b.textContent = t;
    grp.appendChild(b);
  });
}

function buildPmButtons() {
  const pms = Array.from(new Set(DATA.jobs.map(j => j.pm).filter(Boolean))).sort();
  const grp = document.getElementById('filter-pm');
  pms.forEach(p => {
    const b = document.createElement('button');
    b.dataset.v = p;
    b.textContent = p.split(' ')[0];
    grp.appendChild(b);
  });
}

function buildYearButtons() {
  // Union of years from per-job soldDate AND sales deals close/create year,
  // so the filter covers both sides of the page consistently.
  const years = new Set();
  DATA.jobs.forEach(j => { const y = jobYear(j); if (y) years.add(y); });
  if (DATA.sales && DATA.sales.deals) {
    DATA.sales.deals.forEach(d => {
      if (d.closeYear) years.add(d.closeYear);
      else if (d.createYear) years.add(d.createYear);
    });
  }
  const sorted = Array.from(years).sort((a, b) => b - a);
  const grp = document.getElementById('filter-year');
  sorted.forEach(y => {
    const b = document.createElement('button');
    b.dataset.v = String(y);
    b.textContent = String(y);
    grp.appendChild(b);
  });
}

function wireFilters() {
  ['filter-archived', 'filter-type', 'filter-pm', 'filter-year'].forEach(id => {
    const grp = document.getElementById(id);
    const key = id.replace('filter-', '');
    grp.addEventListener('click', e => {
      if (e.target.tagName !== 'BUTTON') return;
      filters[key] = e.target.dataset.v;
      grp.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === filters[key]));
      render();
      renderSalesPipeline();
    });
  });
}

function buildHeader() {
  const tr = document.getElementById('thead-row');
  COLS.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c.label;
    th.dataset.key = c.key;
    if (c.type === 'money' || c.type === 'money-signed' || c.type === 'money-signed-inverse' || c.type === 'pct-signed' || c.type === 'pct' || c.type === 'num') th.classList.add('r');
    th.addEventListener('click', () => {
      if (sortKey === c.key) sortDir = -sortDir;
      else { sortKey = c.key; sortDir = -1; }
      render();
    });
    tr.appendChild(th);
  });
}

function applyFilters(jobs) {
  return jobs.filter(j => {
    if (filters.archived === 'archived' && !j.archived) return false;
    if (filters.archived === 'active' && j.archived) return false;
    if (filters.type !== 'all' && j.type !== filters.type) return false;
    if (filters.pm !== 'all' && j.pm !== filters.pm) return false;
    if (filters.year !== 'all' && String(jobYear(j)) !== filters.year) return false;
    return true;
  });
}

function sortJobs(jobs) {
  const dir = sortDir;
  return jobs.slice().sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function buildRollups(jobs) {
  // Group by type
  const groups = {};
  jobs.forEach(j => {
    if (!j.type) return;
    (groups[j.type] = groups[j.type] || []).push(j);
  });
  const div = document.getElementById('rollups');
  div.innerHTML = '';

  // Overall card
  div.appendChild(makeRoll('All visible', jobs));

  Object.keys(groups).sort().forEach(t => {
    div.appendChild(makeRoll(t, groups[t]));
  });
}

function avg(arr, key) {
  const vals = arr.map(x => x[key]).filter(v => v !== null && v !== undefined && !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function sum(arr, key) {
  return arr.reduce((s, x) => s + (x[key] || 0), 0);
}

function makeRoll(label, jobs) {
  const planPct = avg(jobs, 'plannedMarginPct');
  const actPct = avg(jobs, 'actualMarginPct');
  const cls = (v) => v === null ? 'muted' : (v >= 25 ? 'ok' : v >= 10 ? 'warn' : 'bad');
  const totalRev = sum(jobs, 'revenueExGST');
  const totalPlanCost = sum(jobs, 'plannedCost');
  const totalActCost = sum(jobs, 'actualCost');
  const avgBuild = avg(jobs, 'buildCycleDays');
  const avgSite = avg(jobs, 'siteDays');
  const avgProfitDay = avg(jobs, 'profitPerBuildDay');

  const div = document.createElement('div');
  div.className = 'roll';
  div.innerHTML =
    '<div class="label">' + label + '</div>' +
    '<div class="big">' + jobs.length + ' jobs · ' +
    '<span class="' + cls(actPct) + '">' + (actPct === null ? '—' : actPct.toFixed(1) + '%') + ' actual</span></div>' +
    '<div class="stats">' +
    '<div><span>Plan margin</span><span class="' + cls(planPct) + '">' + (planPct === null ? '—' : planPct.toFixed(1) + '%') + '</span></div>' +
    '<div><span>Avg build cycle</span><span>' + (avgBuild === null ? '—' : Math.round(avgBuild) + 'd') + '</span></div>' +
    '<div><span>Total revenue</span><span>$' + Math.round(totalRev).toLocaleString() + '</span></div>' +
    '<div><span>Avg site days</span><span>' + (avgSite === null ? '—' : Math.round(avgSite) + 'd') + '</span></div>' +
    '<div><span>Plan cost total</span><span>$' + Math.round(totalPlanCost).toLocaleString() + '</span></div>' +
    '<div><span>Avg $/build day</span><span>' + (avgProfitDay === null ? '—' : '$' + Math.round(avgProfitDay).toLocaleString()) + '</span></div>' +
    '<div><span>Actual cost total</span><span>$' + Math.round(totalActCost).toLocaleString() + '</span></div>' +
    '</div>';
  return div;
}

function render() {
  const filtered = applyFilters(DATA.jobs);
  buildRollups(filtered);

  document.querySelectorAll('th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.key === sortKey) th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
  });

  const sorted = sortJobs(filtered);
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = sorted.map(j => {
    const tds = COLS.map(c => {
      let v = j[c.key];
      let html;
      if (c.key === 'name') {
        html = '<a href="' + j.slug + '/">' + j.name + '</a>';
      } else {
        html = fmt(v, c.type);
      }
      const cls = ['money','money-signed','money-signed-inverse','pct-signed','pct','num'].includes(c.type) ? ' class="r"' : '';
      const cl2 = c.key === 'name' ? ' class="name"' : cls;
      return '<td' + cl2 + '>' + html + '</td>';
    }).join('');
    return '<tr' + (j.archived ? ' class="archived"' : '') + '>' + tds + '</tr>';
  }).join('');

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="' + COLS.length + '" style="text-align:center;padding:30px;color:#7fa8cc">No jobs match these filters.</td></tr>';
  }

  document.getElementById('gen').textContent = 'Generated ' + DATA.generated + ' · ' + DATA.jobs.length + ' total dashboards';
}

function winClass(rate) {
  if (rate === null || rate === undefined) return '';
  if (rate >= 0.7) return 'hi';
  if (rate >= 0.45) return 'mid';
  return 'lo';
}

function dealMeanCycle(deals) {
  const vals = deals.map(d => d.salesCycleDays).filter(v => v !== null && v !== undefined && !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function dealMeanValue(deals) {
  const vals = deals.map(d => d.dealValue).filter(v => v !== null && v !== undefined && !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function aggregateBy(deals, keyOf, includeUntaggedBucket) {
  // keyOf returns an array of keys (so a deal with multiple types appears in
  // multiple buckets) or a single string. Untagged deals go to the special
  // bucket name so the table can flag them.
  const buckets = {};
  deals.forEach(d => {
    let keys = keyOf(d);
    if (!Array.isArray(keys)) keys = keys ? [keys] : [];
    if (keys.length === 0) keys = [includeUntaggedBucket];
    keys.forEach(k => {
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(d);
    });
  });
  const out = {};
  Object.keys(buckets).forEach(k => {
    const arr = buckets[k];
    const won = arr.filter(d => d.outcome === 'won');
    const lost = arr.filter(d => d.outcome === 'lost');
    const open = arr.filter(d => d.outcome === 'open');
    const ambiguous = arr.filter(d => d.outcome === 'ambiguous');
    const closed = won.length + lost.length;
    out[k] = {
      total: arr.length,
      won: won.length,
      lost: lost.length,
      open: open.length,
      ambiguous: ambiguous.length,
      winRate: closed > 0 ? won.length / closed : null,
      avgSalesCycleDays: dealMeanCycle(won),
      avgWonValue: dealMeanValue(won),
    };
  });
  return out;
}

function renderSalesPipeline() {
  const s = DATA.sales;
  const wrap = document.getElementById('sales-pipeline');
  if (!s) {
    wrap.innerHTML = '<div class="discipline"><b>Sales pipeline data not loaded.</b> Run <code>node fetch-sales-data.js</code> to populate win-rate, lead-source, and sales-cycle metrics.</div>';
    return;
  }

  // Filter raw deals by year and re-aggregate. closeYear takes priority
  // (year the deal was won/lost); fall back to createYear for open deals
  // so the bucket still shows what's currently in flight.
  const yearFilter = filters.year;
  const dealsAll = s.deals || [];
  const dealsFiltered = yearFilter === 'all'
    ? dealsAll
    : dealsAll.filter(d => {
        const y = String(d.closeYear || d.createYear || '');
        return y === yearFilter;
      });

  const byType = aggregateBy(dealsFiltered, d => d.types, '(no type set)');
  const byLeadSource = aggregateBy(dealsFiltered, d => d.leadSource, '(unknown)');

  const totalDeals = dealsFiltered.length;
  const wonCount = dealsFiltered.filter(d => d.outcome === 'won').length;
  const lostCount = dealsFiltered.filter(d => d.outcome === 'lost').length;
  const openCount = dealsFiltered.filter(d => d.outcome === 'open').length;
  const ambiguousCount = dealsFiltered.filter(d => d.outcome === 'ambiguous').length;
  const overallWinRate = (wonCount + lostCount) > 0 ? wonCount / (wonCount + lostCount) : null;
  const ambiguousPct = totalDeals > 0 ? Math.round(ambiguousCount / totalDeals * 100) : 0;
  const overallAvgCycle = dealMeanCycle(dealsFiltered.filter(d => d.outcome === 'won'));

  // Repeat clients within this year filter
  const byClient = {};
  dealsFiltered.forEach(d => { if (d.clientKey) (byClient[d.clientKey] = byClient[d.clientKey] || []).push(d); });
  const repeatClients = Object.entries(byClient)
    .filter(e => e[1].length > 1)
    .map(e => ({
      clientKey: e[0],
      displayName: e[1][0].name,
      dealCount: e[1].length,
      wonCount: e[1].filter(d => d.outcome === 'won').length,
      totalWonValue: e[1].filter(d => d.outcome === 'won').reduce((s, d) => s + (d.dealValue || 0), 0),
    }))
    .sort((a, b) => b.dealCount - a.dealCount);

  const typeTotal = Object.values(byType).reduce((a, b) => a + b.total, 0);
  const noTypePct = typeTotal > 0 ? Math.round((byType['(no type set)'] ? byType['(no type set)'].total : 0) / typeTotal * 100) : 0;
  const noSrcPct = totalDeals > 0 ? Math.round((byLeadSource['(unknown)'] ? byLeadSource['(unknown)'].total : 0) / totalDeals * 100) : 0;

  // Local view: don't mutate DATA.sales so the next filter change re-reads
  // the full deals array cleanly.
  const view = {
    totalDeals, wonCount, lostCount, openCount, ambiguousCount, ambiguousPct,
    overallWinRate, overallAvgSalesCycleDays: overallAvgCycle,
    byType, byLeadSource, repeatClients,
    noTypePct, noSrcPct,
  };

  // Data-quality actions — computed fresh from the filtered deals every
  // render. Owners are SBI roles, not specific people; if Gail is on leave
  // someone else assumes the role. Severity drives the colour bar.
  const ambiguousInRecent = dealsFiltered.filter(d =>
    d.outcome === 'ambiguous' && (d.closeYear >= 2025 || d.createYear >= 2025)).length;
  const untaggedType = dealsFiltered.filter(d => d.types.length === 0 && (d.outcome === 'won' || d.outcome === 'lost' || d.outcome === 'open')).length;
  const untaggedSource = dealsFiltered.filter(d => !d.leadSource && (d.outcome === 'won' || d.outcome === 'lost' || d.outcome === 'open')).length;
  const webFormLeads = dealsFiltered.filter(d => d.leadSource === 'Web Form');
  const webFormWon = webFormLeads.filter(d => d.outcome === 'won').length;
  const repeatClientsWithoutSource = (view.repeatClients || []).length; // proxy — full check would need per-deal lookup
  const archivedJobs = (DATA.jobs || []).filter(j => j.archived);
  const jobsMissingSold = archivedJobs.filter(j => !j.soldDate).length;
  const jobsLikelyMissingLabour = archivedJobs.filter(j =>
    j.actualMarginPct !== null && j.plannedMarginPct !== null &&
    j.actualMarginPct - j.plannedMarginPct > 15
  ).length;

  const actions = [
    {
      count: ambiguousCount,
      owner: 'Gail',
      title: 'Re-code legacy "done complete" deals',
      desc: 'Historic deals closed under the generic "done complete" status — could be won, lost, or abandoned. Bulk-filter by status in the Deals list and re-tag each as closed-won or done-lost based on whether they became a project.',
      action: 'Bulk-filter Deals list by status="done complete", spot-check + recode each',
      impact: 'Makes 2023/2024 win-rate trustworthy',
      severity: ambiguousCount > 100 ? 'high' : ambiguousCount > 20 ? 'med' : 'low',
    },
    {
      count: untaggedSource,
      owner: 'Gail',
      title: 'Set Lead Source on every new deal',
      desc: 'Active and recent deals without a Lead Source set. Without this we cannot measure which channels actually pay (Search vs Referral vs Existing Client vs 1300 Number).',
      action: 'Add field to deal-creation routine; bulk-fill backlog from email source for last 90 days',
      impact: 'Enables marketing-ROI decisions',
      severity: untaggedSource > 200 ? 'high' : untaggedSource > 50 ? 'med' : 'low',
    },
    {
      count: untaggedType,
      owner: 'Gail',
      title: 'Set Job Type on every new deal',
      desc: 'Active and recent deals without a Job Type tag. Without this, per-type win rates (Hospitality, Office, Joinery, etc.) cannot be trusted to inform focus decisions.',
      action: 'Add field to deal-creation routine; tag backlog from deal name / scope notes',
      impact: 'Enables focus-area decisions',
      severity: untaggedType > 200 ? 'high' : untaggedType > 50 ? 'med' : 'low',
    },
    {
      count: webFormLeads.length,
      owner: 'Michael',
      title: 'Investigate Web Form lead conversion',
      desc: webFormWon === 0 && webFormLeads.length > 0
        ? webFormLeads.length + ' of ' + webFormLeads.length + ' Web Form leads lost (0% conversion). Either the form is sending tyre-kickers or the follow-up sequence is broken.'
        : 'Web Form conversion ' + (webFormLeads.length > 0 ? Math.round(webFormWon / webFormLeads.length * 100) + '%' : '—') + '. Review whether the form qualifies leads or just generates noise.',
      action: 'Pull the form responses; check qualification questions; review follow-up cadence',
      impact: 'Saves wasted quoting time OR rescues a working channel',
      severity: webFormWon === 0 && webFormLeads.length >= 3 ? 'med' : 'info',
    },
    {
      count: jobsLikelyMissingLabour,
      owner: 'Chadd',
      title: 'Record labour costs on small jobs at close-out',
      desc: 'Archived jobs where actual margin is 15+ points HIGHER than planned — almost always means labour hours were NOT entered on the cost sheet, not that the job was actually that profitable.',
      action: 'At job close-out, reconcile labour hours from time-tracking into 30x cost codes',
      impact: 'Makes actual margin column honest for $/build-day rankings',
      severity: jobsLikelyMissingLabour >= 3 ? 'med' : 'info',
    },
    {
      count: jobsMissingSold,
      owner: 'Gail',
      title: 'Set Date Sold on every archived job dashboard',
      desc: 'Archived dashboards where dateSold is missing — sales cycle and build cycle cannot be calculated, so the job is excluded from the $/build-day ranking.',
      action: 'Fill dateSold on each project Sales Task; refresh-dashboards picks it up on next Tuesday',
      impact: 'Complete sales-cycle data across all archived jobs',
      severity: jobsMissingSold > 0 ? 'low' : 'info',
    },
  ].filter(a => a.severity !== 'info' || a.count > 0); // hide info actions when count is 0

  view.actions = actions;

  const sortByTotal = (a, b) => b[1].total - a[1].total;
  const tagged = ([k]) => k !== '(no type set)' && k !== '(unknown)';
  const untagged = ([k]) => k === '(no type set)' || k === '(unknown)';

  const typeRows = Object.entries(view.byType).sort(sortByTotal)
    .filter(tagged).map(([k, v]) => row(k, v)).join('')
    + Object.entries(view.byType).filter(untagged).map(([k, v]) => row(k, v, true)).join('');
  const srcRows = Object.entries(view.byLeadSource).sort(sortByTotal)
    .filter(tagged).map(([k, v]) => row(k, v)).join('')
    + Object.entries(view.byLeadSource).filter(untagged).map(([k, v]) => row(k, v, true)).join('');

  function row(label, v, isUntagged) {
    const wr = v.winRate;
    const wrTxt = wr === null ? '—' : Math.round(wr * 100) + '%';
    const barW = wr === null ? 0 : Math.round(wr * 70);
    const cycle = v.avgSalesCycleDays === null ? '—' : Math.round(v.avgSalesCycleDays) + 'd';
    const aw = v.avgWonValue ? '$' + Math.round(v.avgWonValue).toLocaleString() : '—';
    const displayLabel = isUntagged
      ? '<span style="color:#f59e0b">⚠️ ' + (label === '(no type set)' ? 'No Job Type set' : 'No Lead Source set') + '</span>'
      : label;
    const trAttr = isUntagged
      ? ' style="background:rgba(239,68,68,.08);border-top:1px solid #3a1a1a"'
      : '';
    return '<tr' + trAttr + '>' +
      '<td>' + displayLabel + '</td>' +
      '<td class="r">' + v.total + '</td>' +
      '<td class="r" style="color:#22c55e">' + v.won + '</td>' +
      '<td class="r" style="color:#ef4444">' + v.lost + '</td>' +
      '<td class="r" style="color:#94a3b8" title="Status done-complete — outcome ambiguous, excluded from win-rate">' + (v.ambiguous || 0) + '</td>' +
      '<td class="r"><span class="winbar ' + winClass(wr) + '" style="width:' + barW + 'px"></span>' + wrTxt + '</td>' +
      '<td class="r">' + aw + '</td>' +
      '<td class="r">' + cycle + '</td>' +
    '</tr>';
  }

  const scopeLabel = yearFilter === 'all' ? 'all-time' : 'closed in ' + yearFilter;
  const totalsLabel = yearFilter === 'all' ? 'Total deals (all time)' : 'Total deals (' + yearFilter + ')';
  const stats =
    '<div class="pipe-overall">' +
      '<div class="stat"><div class="l">' + totalsLabel + '</div><div class="v">' + view.totalDeals + '</div></div>' +
      '<div class="stat"><div class="l">Overall win rate</div><div class="v">' + (view.overallWinRate === null ? '—' : Math.round(view.overallWinRate * 100) + '%') + '</div></div>' +
      '<div class="stat"><div class="l">Won / Lost / Open / ?</div><div class="v">' + view.wonCount + ' / ' + view.lostCount + ' / ' + view.openCount + ' / ' + view.ambiguousCount + '</div></div>' +
      '<div class="stat"><div class="l">Avg sales-cycle (won)</div><div class="v">' + (view.overallAvgSalesCycleDays ? Math.round(view.overallAvgSalesCycleDays) + 'd' : '—') + '</div></div>' +
    '</div>';

  const tableHead = '<tr><th>Label</th><th class="r">Total</th><th class="r">Won</th><th class="r">Lost</th><th class="r" title="Status done-complete — outcome ambiguous">?</th><th class="r">Win %</th><th class="r">Avg won $</th><th class="r">Avg cycle</th></tr>';

  const repeatHtml = (view.repeatClients || []).map(function(c) {
    return '<div class="repeat-chip"><b>' + c.displayName + '</b>' + c.dealCount + ' deals · ' + c.wonCount + ' won' + (c.totalWonValue ? ' · $' + Math.round(c.totalWonValue).toLocaleString() : '') + '</div>';
  }).join('');

  const actionsHtml = view.actions.map(function(a) {
    const ownerKey = (a.owner || '').toLowerCase();
    const countDisplay = a.count === 0 ? '✓' : a.count.toLocaleString();
    const countClass = a.count === 0 ? 'dq-count zero' : 'dq-count';
    return '<div class="dq-action sev-' + a.severity + '">' +
      '<div class="' + countClass + '">' + countDisplay + '</div>' +
      '<div class="dq-body">' +
        '<div class="t">' + a.title + '</div>' +
        '<div class="d">' + a.desc + '</div>' +
        '<div class="a">' + a.action + '</div>' +
      '</div>' +
      '<div class="dq-right">' +
        '<span class="dq-owner ' + ownerKey + '">' + a.owner + '</span>' +
        '<span class="dq-impact">' + a.impact + '</span>' +
      '</div>' +
    '</div>';
  }).join('');

  const dqCard =
    '<div class="dq-card">' +
      '<div class="dq-head">' +
        '<h3 class="dq-title">🧹 Data Quality Backlog</h3>' +
        '<span class="dq-meta">Refreshed weekly from live ClickUp · ' + scopeLabel + '</span>' +
      '</div>' +
      '<p class="dq-intro">These actions clean up the gaps that make the numbers above less trustworthy. Each is assigned to the SBI role best placed to do it. The list re-computes every Tuesday refresh — items disappear automatically once the underlying data is fixed.</p>' +
      '<div class="dq-list">' + actionsHtml + '</div>' +
      '<div class="dq-foot"><b>How it works:</b> counts recompute live from ClickUp every Tuesday at 7am AEST. <b>If your count drops to zero,</b> the action disappears next refresh. <b>If a new gap emerges</b> (e.g. tagging discipline slips for a few weeks), it surfaces here automatically.</div>' +
    '</div>' + renderCeoLens();

  function renderCeoLens() {
    const c = DATA.ceo;
    if (!c || !c.recommendations) {
      return '<div class="ceo-card">' +
        '<div class="ceo-head"><h3 class="ceo-title">🧠 CEO Lens — External Perspective</h3><span class="ceo-meta">Not yet generated</span></div>' +
        '<div class="ceo-empty">' +
          '<b>Monthly strategic brief:</b> when this runs, it uses Claude Opus 4.7 with web search to research NSW Central Coast + Newcastle fitout competitors, construction outlook, BCA changes, SEO trends, pricing benchmarks, and trade-market shifts. ' +
          'Outputs 5-8 recommendations grounded in SBI\\'s actual numbers, each citing source URLs.' +
          '<br><br>' +
          '<b>To enable:</b> set <code>ANTHROPIC_API_KEY</code> in Windows user environment variables, then run <code>node ceo-advice.js</code> once. After that, the monthly Tuesday cron handles it automatically. Cost: ~$1-$3 per monthly run.' +
        '</div>' +
      '</div>';
    }

    const headline = c.keyInsight
      ? '<div class="ceo-headline"><b>Headline:</b> ' + escapeHtml(c.keyInsight) + '</div>'
      : '';

    const recs = (c.recommendations || []).map(function(r) {
      const sourcesHtml = (r.sources || []).map(function(s) {
        return '<a href="' + escapeAttr(s.url) + '" target="_blank" rel="noopener">' + escapeHtml(s.title || s.url) + '</a>';
      }).join(' · ');
      return '<div class="ceo-rec">' +
        '<div class="ceo-rec-top">' +
          '<span class="ceo-chip cat">' + escapeHtml(r.category || '—') + '</span>' +
          '<span class="ceo-chip conf-' + escapeAttr(r.confidence || 'medium') + '">' + escapeHtml(r.confidence || '—') + ' confidence</span>' +
          '<span class="ceo-chip hor">' + escapeHtml(r.horizon || '—').replace('-', ' ') + '</span>' +
        '</div>' +
        '<h4>' + escapeHtml(r.title || '') + '</h4>' +
        '<p class="ev">' + escapeHtml(r.evidence || '') + '</p>' +
        '<p class="rs">' + escapeHtml(r.reasoning || '') + '</p>' +
        '<div class="act">' + escapeHtml(r.action || '') + '</div>' +
        '<div class="imp">' + escapeHtml(r.impact || '') + '</div>' +
        (sourcesHtml ? '<div class="sources">📎 ' + sourcesHtml + '</div>' : '') +
      '</div>';
    }).join('');

    const scope = c.researchScope || {};
    const scopeHtml = (scope.competitorsFound || []).length
      ? '<div class="ceo-scope">' +
          '<b>Competitors researched:</b> ' + (scope.competitorsFound || []).map(escapeHtml).join(' · ') + '<br>' +
          '<b>Topics covered:</b> ' + (scope.trendsCovered || []).map(escapeHtml).join(' · ') +
        '</div>'
      : '';

    return '<div class="ceo-card">' +
      '<div class="ceo-head">' +
        '<h3 class="ceo-title">🧠 CEO Lens — External Perspective</h3>' +
        '<span class="ceo-meta">' + escapeHtml(c.monthCovered || 'Monthly brief') + ' · generated ' + (c.generated ? c.generated.slice(0, 10) : '—') + ' · ' + (c.model || 'claude') + '</span>' +
      '</div>' +
      headline +
      '<div class="ceo-list">' + recs + '</div>' +
      scopeHtml +
    '</div>';
  }

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function escapeAttr(s) { return escapeHtml(s); }

  wrap.innerHTML =
    '<h2 class="section-h">📈 Sales Pipeline (' + scopeLabel + ', Deals list)</h2>' +
    stats +
    dqCard +
    '<div class="discipline">' +
      '<b>Ambiguous-outcome warning:</b> ' + view.ambiguousPct + '% of deals in this view (' + view.ambiguousCount + ' of ' + view.totalDeals + ') are in legacy status <b>"done complete"</b> ' +
      '— could be won, lost, or abandoned. Excluded from win-rate maths (shown in the <b>?</b> column for transparency). ' +
      'Historic years (2023, 2024) are heavily affected because the team used "done complete" as the default close status before formalising closed-won / done-lost. 2025+ data is more reliable.' +
      '<br><b>Data discipline gap:</b> ' + view.noTypePct + '% of deals have no <b>Job Type</b> set, and ' + view.noSrcPct + '% have no <b>Lead Source</b> set. ' +
      'The breakdowns below only reflect the ' + (100 - view.noTypePct) + '% / ' + (100 - view.noSrcPct) + '% with tagged data. ' +
      'Every new deal needs both fields filled in.' +
      '<br><b>Sales-cycle caveat:</b> "avg cycle" = date_created → date_done on the deal task. Some legacy deals were closed long after creation; treat as a directional signal.' +
    '</div>' +
    '<div class="pipeline">' +
      '<div class="pipe-card">' +
        '<h3>By Job Type — which work converts?</h3>' +
        '<table><thead>' + tableHead + '</thead><tbody>' + typeRows + '</tbody></table>' +
      '</div>' +
      '<div class="pipe-card">' +
        '<h3>By Lead Source — where do we find them?</h3>' +
        '<table><thead>' + tableHead + '</thead><tbody>' + srcRows + '</tbody></table>' +
      '</div>' +
    '</div>' +
    (repeatHtml ? '<h3 style="font-size:12px;color:#7fa8cc;text-transform:uppercase;letter-spacing:.8px;margin:20px 0 10px">🔁 Repeat clients (' + view.repeatClients.length + ')</h3><div class="repeat-list">' + repeatHtml + '</div>' : '');
}

buildHeader();
buildTypeButtons();
buildPmButtons();
buildYearButtons();
wireFilters();
renderSalesPipeline();
render();
</script>
</body>
</html>`;
}

main();

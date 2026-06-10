#!/usr/bin/env node
/**
 * SBI Dashboard Refresh Worker
 * ============================
 * Refreshes deterministic data (claims, budget, schedule, site works,
 * compliance, metrics) on existing project dashboards by pulling fresh
 * ClickUp data via the REST API. Narrative + engine-computed fields (actions,
 * projectSummary, milestoneGroups, phase, and the Project Intelligence Engine
 * reads changesSinceReview / outstanding / emailLog.ballInCourt) are preserved
 * from the existing dashboard via the `{...existing}` spread in the merge below
 * — they are populated by the engine (project-health-check html mode), not here.
 *
 * Usage:
 *   node refresh.js                       # refresh all projects
 *   node refresh.js hungry-wolfs,natural  # refresh by slug (substring match)
 *   node refresh.js 260306,260325         # refresh by job number
 *
 * Environment:
 *   CLICKUP_API_TOKEN (required)
 *
 * Exit code:
 *   0 = all targets refreshed successfully
 *   1 = at least one target failed (see summary at end)
 *   2 = configuration error (no token, no projects found)
 *
 * Designed to run autonomously — never prompts, never blocks.
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const TOKEN = process.env.CLICKUP_API_TOKEN || process.env.CLICKUP_TOKEN;
const REPO_ROOT = path.resolve(__dirname);

const SBI_PROJECTS_SPACE = '54603442';
const DEALS_LIST = '900301389267';
const JOB_NUMBER_PREFIX = /^(\d{6})\b/;
const DATE_SOLD_FIELD = '318fa7ac-a502-496d-a7fa-d28cbe07ae6c'; // Date Sold on the sales task (epoch ms)

const FIELDS = {
  budgetAllowance:   'ec6378ba-324d-445a-b9a1-75746b6afe78', // Budget Allowance SBI (currency)
  budgetAllowanceAlt:'f0c6feae-ba3d-446a-9dd6-a1e90b59343e', // Alternate Budget Allowance field (some lists use this)
  actualPO:          '8aba4dde-eaef-46c5-99fd-fb15e62e9715', // Actual PO$ SBI (currency)
  procurementWf:     '2e4fc78f-ea66-436c-902f-c248467c943f', // Procurement Workflow SBI (drop_down)
  invoiceAmount:     '05d666d7-6606-4dd0-8c19-72fcc2312a91', // Invoice Amount incl GST (currency) — primary
  dealValueFallback: 'e54326a0-d0f2-4912-b4d4-ac9872ee979f', // 04. Deal Value (INCL GST) — fallback; some projects enter amounts here instead
  invoiceWf:         '66cb7011-4ea3-465f-8573-ab25dd35e523', // Invoice/Variation Workflow (drop_down)
  pctClaim:          'cfed0b02-6c30-469b-8c10-2443d63b7798', // Percentage Claim (number)
  variationCost:     '7adc45a5-1a53-4394-a3f9-38819a842f60', // Variation Cost (currency)
};

const PROCUREMENT_WF = {
  0:  ['Info Entered/Attached', '#800000'],
  1:  ['Not Started',           '#AF7E2E'],
  2:  ['Quote Request Sent',    '#f9d900'],
  3:  ['To be Quoted/Ordered',  '#FF4081'],
  4:  ['Quote/Qty Takeoff',     '#81B1FF'],
  5:  ['Quote Received',        '#29F08C'],
  6:  ['ADMIN TO ORDER',        '#f900ea'],
  7:  ['Ordered',               '#1bbc9c'],
  8:  ['In Stock',              '#1bbc9c'],
  9:  ['Received',              '#0231E8'],
  10: ['NOT REQUIRED',          '#0231E8'],
  11: ['Wrong Stock Received',  '#39DE48'],
  12: ['Bunnings Pick Up',      '#70563C'],
};

const INVOICE_WF = {
  0: ['Not Sent',                       '#94a3b8'],
  1: ['Send Invoice',                   '#FF4081'],
  2: ['Invoice Paid',                   '#1bbc9c'],
  3: ['Invoice Sent',                   '#ff7800'],
  4: ['Invoice REJECTED',               '#e50000'],
  5: ['Variation sent for Approval',    '#AF7E2E'],
  6: ['Project Credit issued',          '#81B1FF'],
  7: ['NO CHARGE',                      '#667684'],
  8: ['Work Complete',                  '#02BCD4'],
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function log(...args) { console.log('[refresh]', ...args); }
function warn(...args) { console.warn('[refresh] WARN:', ...args); }
function err(...args) { console.error('[refresh] ERROR:', ...args); }

async function clickup(endpoint, opts = {}) {
  const url = endpoint.startsWith('http') ? endpoint : CLICKUP_API + endpoint;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': TOKEN,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp ${res.status} ${endpoint}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function getCustomField(task, fieldId) {
  const cf = (task.custom_fields || []).find(c => c.id === fieldId);
  return cf ? cf.value : undefined;
}

// Job number YYMMDD → epoch ms (UTC midnight). Used only as a last-resort fallback
// when a project's live Date Sold can't be resolved from its sales task.
function jobNumberToEpoch(jobNumber) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(jobNumber || '');
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const t = Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd));
  return Number.isNaN(t) ? null : t;
}

function salesTaskIdFromUrl(url) {
  const m = /\/t\/([a-z0-9]+)/i.exec(url || '');
  return m ? m[1] : null;
}

const isWonStatus = (s) => /won|sold/i.test(s || '');

// The "sold date" = when the sales task was moved to its Won Sold status. ClickUp records
// this as date_done (the won status is a done-type status); fall back to date_closed, then
// the Date Sold custom field. Returns epoch ms or null.
function wonDate(task) {
  const v = task.date_done || task.date_closed || getCustomField(task, DATE_SOLD_FIELD);
  return v ? Number(v) : null;
}

// Resolve the live Won-Sold date for each active project. Primary source: the project's
// salesTaskUrl (the authoritative linked sales task). Projects with no link are matched
// against the Deals list by job number — but ONLY a Won task counts (so a number collision
// with a lost/abandoned deal can't supply a bogus date). Returns Map(slug -> epoch ms | null).
async function resolveSoldDates(activeProjects) {
  const out = new Map();
  const needDealsLookup = [];

  // 1) Direct fetch by sales-task id (parallel, fault-tolerant)
  await Promise.all(activeProjects.map(async (p) => {
    const id = salesTaskIdFromUrl(p.existingData?.project?.salesTaskUrl);
    if (!id) { needDealsLookup.push(p); return; }
    try {
      const task = await clickup(`/task/${id}`);
      out.set(p.slug, wonDate(task));
    } catch (e) {
      warn(`sold-date fetch failed for ${p.slug} (task ${id}): ${e.message}`);
      out.set(p.slug, null);
    }
  }));

  // 2) Deals-list lookup by job number for projects without a usable link.
  //    Match the first 6-digit run anywhere in the name (handles the "TS251213" prefix),
  //    and keep only WON tasks that carry a real won date.
  if (needDealsLookup.length) {
    const wonByJob = new Map();
    try {
      for (let page = 0; page < 6; page++) {
        const data = await clickup(`/list/${DEALS_LIST}/task?include_closed=true&subtasks=false&page=${page}`);
        const tasks = data.tasks || [];
        for (const t of tasks) {
          const jn = (t.name.match(/(\d{6})/) || [])[1];
          if (!jn || !isWonStatus(t.status?.status)) continue;
          const d = wonDate(t);
          if (d != null && !wonByJob.has(jn)) wonByJob.set(jn, d);
        }
        if (data.last_page) break;
      }
    } catch (e) {
      warn(`Deals-list sold-date lookup failed: ${e.message}`);
    }
    for (const p of needDealsLookup) {
      out.set(p.slug, wonByJob.has(p.jobNumber) ? wonByJob.get(p.jobNumber) : null);
    }
  }
  return out;
}

function findJsonBlock(html, id) {
  const re = new RegExp(
    '(<script type="application/json" id="' + id + '">)([\\s\\S]*?)(</script>)'
  );
  const m = html.match(re);
  if (!m) return null;
  return { match: m, content: m[2].trim() };
}

function replaceJsonBlock(html, id, jsonObj) {
  const re = new RegExp(
    '(<script type="application/json" id="' + id + '">)([\\s\\S]*?)(</script>)'
  );
  const json = JSON.stringify(jsonObj);
  return html.replace(re, (_m, open, _content, close) => open + '\n' + json + '\n' + close);
}

// ─────────────────────────────────────────────────────────────
// PROJECT DISCOVERY
// ─────────────────────────────────────────────────────────────

function discoverProjects() {
  const entries = fs.readdirSync(REPO_ROOT, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    const indexPath = path.join(REPO_ROOT, entry.name, 'index.html');
    if (!fs.existsSync(indexPath)) continue;
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      const block = findJsonBlock(html, 'project-data');
      if (!block) { warn(`${entry.name}: no project-data block, skipping`); continue; }
      const data = JSON.parse(block.content);
      const folderId = data.project?.folderId;
      const jobNumber = data.project?.jobNumber;
      const projectName = data.project?.name;
      if (!folderId) { warn(`${entry.name}: no folderId in project-data, skipping`); continue; }
      projects.push({
        slug: entry.name,
        indexPath,
        folderId,
        jobNumber,
        projectName,
        existingData: data,
      });
    } catch (e) {
      warn(`${entry.name}: parse error – ${e.message}`);
    }
  }
  return projects;
}

async function fetchActiveClickUpFolders() {
  const data = await clickup(`/space/${SBI_PROJECTS_SPACE}/folder?archived=false`);
  const folders = data.folders || [];
  return folders
    .map(f => ({
      id: f.id,
      name: f.name,
      jobNumber: (f.name.match(JOB_NUMBER_PREFIX) || [])[1] || null,
      taskCount: f.task_count || 0,
    }))
    .filter(f => f.jobNumber);
}

function computeMissingDashboards(discovered, cuFolders) {
  const dashboardJobs = new Set(discovered.map(p => p.jobNumber).filter(Boolean));
  const dashboardFolderIds = new Set(discovered.map(p => String(p.folderId)).filter(Boolean));
  return cuFolders.filter(f =>
    !dashboardJobs.has(f.jobNumber) && !dashboardFolderIds.has(String(f.id))
  );
}

function filterProjects(projects, args) {
  if (!args || args.length === 0 || args[0] === 'all' || args[0] === '') return projects;
  const tokens = args.flatMap(a => a.split(',')).map(s => s.trim().toLowerCase()).filter(Boolean);
  return projects.filter(p =>
    tokens.some(t =>
      p.slug.toLowerCase().includes(t) ||
      (p.jobNumber || '').toLowerCase().includes(t) ||
      (p.projectName || '').toLowerCase().includes(t)
    )
  );
}

// ─────────────────────────────────────────────────────────────
// INDEX PAGE REBUILD
// ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortType(typeStr) {
  if (!typeStr) return '';
  // Take everything before the first em-dash, en-dash, or " - ", trim, uppercase.
  // Handles: "BUILD" → "BUILD"; "Joinery — Retirement Village..." → "JOINERY";
  // "BUILD — Door supply..." → "BUILD"; "CERT & DESIGN" → "CERT & DESIGN";
  // "Do & Charge" → "DO & CHARGE".
  const head = String(typeStr).split(/\s*[—–]\s*|\s-\s/)[0].trim();
  return head.toUpperCase();
}

function renderCard(project) {
  const slug = project.slug;
  const data = project.existingData?.project || {};
  const name = data.name || project.projectName || slug;
  const jn = project.jobNumber || '';
  const phase = shortType(data.type);
  const typeLine = jn + (phase ? ' - ' + phase : '');
  return `<a class="card" href="${escapeHtml(slug)}/"><h2>${escapeHtml(name)}</h2><div class="type">${escapeHtml(typeLine)}</div><div class="updated" data-slug="${escapeHtml(slug)}">Loading...</div></a>`;
}

async function rebuildIndexPage(allProjects, activeCuFolders, indexPath) {
  if (!fs.existsSync(indexPath)) {
    warn(`index.html not found at ${indexPath} — skipping rebuild`);
    return;
  }

  const activeFolderIds = new Set(activeCuFolders.map(f => String(f.id)));
  const activeProjects = [];
  const archivedProjects = [];
  for (const p of allProjects) {
    if (activeFolderIds.has(String(p.folderId))) activeProjects.push(p);
    else archivedProjects.push(p);
  }

  // Active: ascending by LIVE Date Sold (sales-task field) — oldest project first.
  // Falls back to the job-number date only when the sold date can't be resolved.
  const soldBySlug = await resolveSoldDates(activeProjects);
  const soldEpoch = (p) => {
    const live = soldBySlug.get(p.slug);
    if (live != null) return live;
    const fallback = jobNumberToEpoch(p.jobNumber);
    return fallback != null ? fallback : Number.POSITIVE_INFINITY; // unknown → sort last
  };
  const missingSold = activeProjects.filter(p => soldBySlug.get(p.slug) == null);
  if (missingSold.length) {
    warn(`${missingSold.length} active job(s) have NO Date Sold on the sales task (sorted by job-number date as fallback):`);
    missingSold.forEach(p => warn(`  - ${p.jobNumber} ${p.projectName} (${p.slug})`));
  }
  activeProjects.sort((a, b) => soldEpoch(a) - soldEpoch(b));
  // Archive: descending by jobNumber (most recently sold = most recently archived first)
  archivedProjects.sort((a, b) => (b.jobNumber || '').localeCompare(a.jobNumber || ''));

  const activeBlock = activeProjects.length
    ? `<!-- DASHBOARDS:ACTIVE:BEGIN -->\n<h2 class="section-heading">Active (${activeProjects.length})</h2>\n<div class="grid">\n${activeProjects.map(renderCard).join('\n')}\n</div>\n<!-- DASHBOARDS:ACTIVE:END -->`
    : `<!-- DASHBOARDS:ACTIVE:BEGIN -->\n<!-- DASHBOARDS:ACTIVE:END -->`;

  const archiveBlock = archivedProjects.length
    ? `<!-- DASHBOARDS:ARCHIVE:BEGIN -->\n<h2 class="section-heading">Recently Archived (${archivedProjects.length})</h2>\n<div class="grid archived">\n${archivedProjects.map(renderCard).join('\n')}\n</div>\n<!-- DASHBOARDS:ARCHIVE:END -->`
    : `<!-- DASHBOARDS:ARCHIVE:BEGIN -->\n<!-- DASHBOARDS:ARCHIVE:END -->`;

  let html = fs.readFileSync(indexPath, 'utf8');
  const activeRe = /<!-- DASHBOARDS:ACTIVE:BEGIN -->[\s\S]*?<!-- DASHBOARDS:ACTIVE:END -->/;
  const archiveRe = /<!-- DASHBOARDS:ARCHIVE:BEGIN -->[\s\S]*?<!-- DASHBOARDS:ARCHIVE:END -->/;

  if (!activeRe.test(html) || !archiveRe.test(html)) {
    warn('index.html missing DASHBOARDS markers — skipping rebuild');
    return;
  }
  html = html.replace(activeRe, activeBlock);
  html = html.replace(archiveRe, archiveBlock);
  fs.writeFileSync(indexPath, html, 'utf8');
  log(`Rebuilt index.html: ${activeProjects.length} active, ${archivedProjects.length} archived`);
}

// ─────────────────────────────────────────────────────────────
// CLICKUP FETCH (per project)
// ─────────────────────────────────────────────────────────────

async function fetchListIds(folderId) {
  const data = await clickup(`/folder/${folderId}`);
  const lists = data.lists || [];
  // Map list name → template number (01, 02, ..., 10)
  const map = {};
  for (const l of lists) {
    const m = l.name.match(/✨️(\d{2})/);
    if (m) {
      const tn = m[1];
      // Prefer original (not "copy") for List 08
      if (!map[tn] || /copy/i.test(map[tn].name)) {
        map[tn] = { id: l.id, name: l.name };
      }
    }
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.id]));
}

async function fetchListTasks(listId, includeSubtasks = false) {
  const subParam = includeSubtasks ? '&subtasks=true&include_subtasks=true' : '';
  const data = await clickup(`/list/${listId}/task?include_closed=true${subParam}`);
  return data.tasks || [];
}

async function fetchTaskWithSubtasks(taskId) {
  const data = await clickup(`/task/${taskId}?include_subtasks=true`);
  return data;
}

// ─────────────────────────────────────────────────────────────
// DATA TRANSFORMATION
// ─────────────────────────────────────────────────────────────

function buildClaimsAndVariations(list04Tasks) {
  const claims = [];
  const variations = [];
  let claimNum = 0;
  let varNum = 0;
  for (const t of list04Tasks) {
    const status = (t.status?.status || '').toLowerCase();
    const statusType = (t.status?.type || '').toLowerCase();
    if (status === 'closed' || statusType === 'closed') continue;
    if (/template/i.test(t.name)) continue;

    const amount = parseFloat(
      getCustomField(t, FIELDS.invoiceAmount) ||
      getCustomField(t, FIELDS.dealValueFallback) ||
      0
    );
    const pct = parseFloat(getCustomField(t, FIELDS.pctClaim) || 0);
    const wfIdx = getCustomField(t, FIELDS.invoiceWf);
    const [wfName, wfColor] = INVOICE_WF[wfIdx] || ['Not Sent', '#94a3b8'];

    const isProgressClaim = /progress claim/i.test(t.name) || /progress claim/i.test(status);
    const isVariation = /variation/i.test(status);

    const entry = {
      num: 0,
      name: t.name,
      amount,
      pct,
      workflow: wfName,
      workflowColor: wfColor,
      status: t.status?.status || '',
      notes: '',
      dateCreated: t.date_created ? parseInt(t.date_created) : null,
      dateUpdated: t.date_updated ? parseInt(t.date_updated) : null,
    };

    if (isProgressClaim) {
      claimNum++;
      entry.num = claimNum;
      claims.push(entry);
    } else if (isVariation) {
      varNum++;
      entry.num = varNum;
      entry.approved = /variation.approved/i.test(status) || /1\.\s*variation.approved/i.test(status);
      variations.push(entry);
    }
  }
  return { claims, variations };
}

function buildBudget(list08Tasks) {
  const labour = [];
  const nonLabour = [];
  const labourCodes = new Set(['300', '301', '302', '303', '304', '303_304', '303/304']);

  for (const t of list08Tasks) {
    if (t.parent) continue; // skip subtasks
    if (/template/i.test(t.name)) continue;

    // Match leading 3-digit (or 303_304 / 303/304) cost code, OR variation entries (no code prefix)
    const m = t.name.match(/^(3\d{2}(?:[_/]3\d{2})?)/);
    const code = m ? m[1] : '';
    const codeShort = code ? code.split(/[_/]/)[0] : '';

    const budget = parseFloat(getCustomField(t, FIELDS.budgetAllowance) || getCustomField(t, FIELDS.budgetAllowanceAlt) || 0);
    const actual = parseFloat(getCustomField(t, FIELDS.actualPO) || 0);
    if (budget <= 0 && actual <= 0) continue;

    const wfIdx = getCustomField(t, FIELDS.procurementWf);
    const [wfName, wfColor] = PROCUREMENT_WF[wfIdx] || ['Not Started', '#AF7E2E'];

    const entry = {
      code,
      name: code ? (t.name.replace(/^3\d{2}(?:[_/]3\d{2})?\s*/, '') || t.name) : t.name,
      budget,
      actual,
      status: t.status?.status || 'to do',
      assignee: t.assignees?.[0]?.username || null,
      workflow: wfName,
      workflowColor: wfColor,
      subtasks: [],
    };

    if (labourCodes.has(codeShort) || labourCodes.has(code)) {
      labour.push(entry);
    } else {
      nonLabour.push(entry);
    }
  }

  // Sort labour by code, nonLabour by code
  labour.sort((a, b) => a.code.localeCompare(b.code));
  nonLabour.sort((a, b) => a.code.localeCompare(b.code));

  const totalBudget = [...labour, ...nonLabour].reduce((s, e) => s + (e.budget || 0), 0);
  const totalActual = [...labour, ...nonLabour].reduce((s, e) => s + (e.actual || 0), 0);

  return { labour, nonLabour, totalBudget, totalActual };
}

function buildSchedule(list06Tasks) {
  const out = [];
  for (const t of list06Tasks) {
    if (t.parent) continue; // skip subtasks
    const name = t.name;
    if (!/JOB SOLD|Procurement|Pre-Manufacture|Manufacturing|SITE WORKS/i.test(name)) continue;
    out.push({
      name,
      status: (t.status?.status || 'todo').toLowerCase(),
      start: t.start_date ? parseInt(t.start_date) : null,
      end: t.due_date ? parseInt(t.due_date) : null,
    });
  }
  return out;
}

async function buildSiteWorksTasks(list06Tasks) {
  const parent = list06Tasks.find(t =>
    /^10\.1.*SITE WORKS.*\[SCHEDULE\]/i.test(t.name)
  );
  if (!parent) return [];

  // Re-fetch parent with subtasks expanded
  const detailed = await fetchTaskWithSubtasks(parent.id);
  const subs = detailed.subtasks || [];
  return subs.map(s => ({
    name: s.name,
    start: s.start_date ? parseInt(s.start_date) : null,
    due: s.due_date ? parseInt(s.due_date) : null,
    assignee: s.assignees?.[0]?.username || null,
    status: (s.status?.status || 'not started').toLowerCase(),
  }));
}

// ─── Lifecycle (3-stream timeline) ────────────────────────────
// Derives a { streams: [admin, mfg, site] } object for the Schedule tab.
// Admin = sold/claims/variations; Mfg = procurement/plans/factory/dispatch;
// Site = 10.1 SITE WORKS [SCHEDULE] subtasks.

function soldDateFromJobNumber(jn) {
  // Job number YYMMDD, e.g. "251206" → 6 Dec 2025
  if (!jn || !/^\d{6}/.test(jn)) return null;
  const yy = parseInt(jn.substring(0, 2));
  const mm = parseInt(jn.substring(2, 4));
  const dd = parseInt(jn.substring(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return new Date(2000 + yy, mm - 1, dd).getTime();
}

function toISODate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function shortClaimName(name) {
  return name
    .replace(/^\d+\.\s*/, '')
    .replace(/^(BUILD|DESIGN)[:/]\s*/i, '')
    .replace(/Invoice\s+(\d+%)/i, '($1)')
    .replace(/\s+-\s+/, ' ')
    .trim();
}

function workflowToStatus(wf) {
  const w = (wf || '').toLowerCase();
  if (/paid|approved/.test(w)) return 'done';
  if (/sent|approval/.test(w)) return 'wip';
  return 'pending';
}

function scheduleStatus(s) {
  const st = (s || '').toLowerCase();
  if (/done|complete|closed/.test(st)) return 'done';
  if (/progress|wip/.test(st)) return 'wip';
  return 'pending';
}

function fmtMoneyShort(n) {
  if (!n && n !== 0) return '';
  return '$' + Math.round(n).toLocaleString('en-AU');
}

function buildLifecycle(project, claims, variations, schedule, siteWorksTasks) {
  // ── Admin stream ─────────────────────────────────────
  const admin = {
    id: 'admin',
    label: '📋 Admin & Finance',
    color: '#4338ca',
    activeFrom: null,
    milestones: []
  };

  const soldTs = soldDateFromJobNumber(project.jobNumber);
  if (soldTs) {
    admin.milestones.push({
      name: 'Sold',
      date: toISODate(soldTs),
      status: 'done',
      detail: `Deal value ${fmtMoneyShort(project.dealValue)} incl GST`
    });
  }

  // Claims — only show a dot once the workflow field has been set past "Not Sent".
  // The dot is positioned at date_updated (the moment the workflow last changed:
  // either when the invoice was issued, or when it was later marked paid).
  // When a claim is paid after being sent, date_updated ticks to the paid date,
  // and the dot visually "moves" on the next refresh.
  const sortedClaims = [...claims].sort((a, b) => (a.dateCreated || 0) - (b.dateCreated || 0));
  sortedClaims.forEach(c => {
    if (/^not sent$/i.test((c.workflow || '').trim())) return; // skip untouched claims
    const ts = c.dateUpdated;
    if (!ts) return;
    admin.milestones.push({
      name: shortClaimName(c.name),
      date: toISODate(ts),
      status: workflowToStatus(c.workflow),
      detail: `${c.name} · ${fmtMoneyShort(c.amount)} · ${c.workflow}`
    });
  });

  // Variations — same rule: skip until workflow has been moved past default/unset
  const sortedVars = [...variations].sort((a, b) => (a.dateCreated || 0) - (b.dateCreated || 0));
  sortedVars.forEach(v => {
    if (/^not sent$/i.test((v.workflow || '').trim())) return;
    const ts = v.dateUpdated;
    if (!ts) return;
    admin.milestones.push({
      name: `V${v.num}`,
      date: toISODate(ts),
      status: workflowToStatus(v.workflow),
      detail: `${v.name} · ${fmtMoneyShort(v.amount)} · ${v.workflow}`
    });
  });

  // ── Mfg stream ──
  // Two phases: Pre-manufacture (from List 06 task "7.1.2 PLANNED dates") and
  // Manufacture (from List 06 task "9.1.1 PLANED Dates"). Each phase is a
  // coloured segment on the spine from its start_date to its due_date.
  const mfg = {
    id: 'mfg',
    label: '🏭 Manufacturing',
    color: '#ca8a04',
    activeFrom: null,
    milestones: []
  };
  const PRE_COLOR = '#ca8a04'; // amber — Pre-manufacture phase
  const MFG_COLOR = '#ea580c'; // deep orange — Manufacture phase

  const preTask = schedule.find(s => /^7\.1\.2/.test(s.name));
  const mfgTask = schedule.find(s => /^9\.1\.1/.test(s.name));

  if (preTask && preTask.start) {
    mfg.milestones.push({
      name: 'Pre-manufacture Start',
      date: toISODate(preTask.start),
      status: scheduleStatus(preTask.status),
      segmentColor: PRE_COLOR,
      detail: preTask.name
    });
  }
  if (preTask && preTask.end) {
    mfg.milestones.push({
      name: 'Pre-manufacture Finish',
      date: toISODate(preTask.end),
      status: scheduleStatus(preTask.status),
      detail: preTask.name
    });
  }
  if (mfgTask && mfgTask.start) {
    mfg.milestones.push({
      name: 'Manufacture Start',
      date: toISODate(mfgTask.start),
      status: scheduleStatus(mfgTask.status),
      segmentColor: MFG_COLOR,
      detail: mfgTask.name
    });
  }
  if (mfgTask && mfgTask.end) {
    mfg.milestones.push({
      name: 'Manufacture Finish',
      date: toISODate(mfgTask.end),
      status: scheduleStatus(mfgTask.status),
      detail: mfgTask.name
    });
  }
  mfg.milestones.sort((a, b) => a.date.localeCompare(b.date));

  // ── Site stream — Start on Site + Last completed site task + named milestones ──
  // Green segment coloured between Start on Site and Last completed site task.
  const site = {
    id: 'site',
    label: '🏗️ Site Works',
    color: '#15803d',
    activeFrom: null,
    milestones: []
  };
  const SITE_COLOR = '#15803d';

  // Start on Site — prefer subtask named "Start on site"; fallback to 10.1 parent from schedule
  const startTask = siteWorksTasks.find(t => {
    const n = (t.name || '').toLowerCase().replace(/[_.]/g, ' ').trim();
    return /^start on site/.test(n);
  });
  const tenOneTask = schedule.find(s => /^10\.1/.test(s.name) || /SITE WORKS/i.test(s.name));
  const startTs = (startTask && (startTask.start || startTask.due)) || (tenOneTask && tenOneTask.start);

  if (startTs) {
    site.milestones.push({
      name: 'Start on Site',
      date: toISODate(startTs),
      status: startTask ? scheduleStatus(startTask.status) : 'pending',
      segmentColor: SITE_COLOR,
      detail: startTask ? startTask.name : (tenOneTask ? tenOneTask.name : '')
    });
  }

  // Last completed site task (by due/start date, where status = done)
  let lastCompleted = null;
  siteWorksTasks.forEach(t => {
    if (!/done|complete/i.test(t.status || '')) return;
    const ts = t.due || t.start;
    if (!ts) return;
    const curTs = lastCompleted ? (lastCompleted.due || lastCompleted.start) : 0;
    if (ts > curTs) lastCompleted = t;
  });
  if (lastCompleted) {
    const ts = lastCompleted.due || lastCompleted.start;
    site.milestones.push({
      name: 'Last Site Task',
      date: toISODate(ts),
      status: 'done',
      detail: `Last completed: ${lastCompleted.name}`
    });
  }

  // Also keep other key named milestones if present (Practical Completion, Completions Stage, Final Handover)
  siteWorksTasks.forEach(t => {
    const n = (t.name || '').toLowerCase().replace(/[_.]/g, ' ').trim();
    let displayName = null;
    if (/^practical completion/.test(n)) displayName = 'Practical Completion';
    else if (/^completions? stage/.test(n) || /^competions? stage/.test(n)) displayName = 'Completions Stage';
    else if (/^final handover/.test(n)) displayName = 'Final Handover';
    if (!displayName) return;
    const ts = t.start || t.due;
    if (!ts) return;
    site.milestones.push({
      name: displayName,
      date: toISODate(ts),
      status: scheduleStatus(t.status),
      detail: `${t.status || ''}${t.assignee ? ' · ' + t.assignee : ''}`.trim()
    });
  });

  site.milestones.sort((a, b) => a.date.localeCompare(b.date));

  return { streams: [admin, mfg, site] };
}

function buildCompliance(list03Tasks) {
  const out = [];
  for (const t of list03Tasks) {
    if (t.parent) continue;
    const status = (t.status?.status || '').toLowerCase();
    let s = 'todo';
    if (/done|complete|closed/.test(status)) s = 'done';
    else if (/in progress|wip|work in progress/.test(status)) s = 'wip';
    out.push({
      name: t.name,
      status: s,
      assignee: t.assignees?.[0]?.username || null,
    });
  }
  return out;
}

function recomputeMetrics(existing, claims, variations, _budget, siteWorks) {
  const claimsTotal = claims.reduce((s, c) => s + (c.amount || 0), 0);
  const varTotal = variations.reduce((s, v) => s + (v.approved !== false ? (v.amount || 0) : 0), 0);
  const contractValue = claimsTotal + varTotal;
  const fmt = n => '$' + Math.round(n).toLocaleString('en-US');

  const swDone = siteWorks.filter(s => /done|complete/i.test(s.status)).length;
  const swTotal = siteWorks.length;

  return {
    ...existing,
    contractValue: {
      ...existing.contractValue,
      value: fmt(contractValue),
      sub: `Contract ${fmt(claimsTotal)} + Variations ${fmt(varTotal)}`,
    },
    siteWorks: {
      ...existing.siteWorks,
      value: `${swDone}/${swTotal}`,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// PROJECT REFRESH
// ─────────────────────────────────────────────────────────────

async function refreshProject(project) {
  log(`▶ ${project.slug} (${project.jobNumber} ${project.projectName}) folder=${project.folderId}`);

  // 1. Fetch list IDs
  const listIds = await fetchListIds(project.folderId);
  log(`  lists found:`, Object.keys(listIds).join(','));

  // 2. Fetch the lists we need (parallel)
  const [list03, list04, list06, list08] = await Promise.all([
    listIds['03'] ? fetchListTasks(listIds['03']) : Promise.resolve([]),
    listIds['04'] ? fetchListTasks(listIds['04']) : Promise.resolve([]),
    listIds['06'] ? fetchListTasks(listIds['06']) : Promise.resolve([]),
    listIds['08'] ? fetchListTasks(listIds['08']) : Promise.resolve([]),
  ]);

  // 3. Build deterministic data
  const { claims, variations } = buildClaimsAndVariations(list04);
  const budget = buildBudget(list08);
  const schedule = buildSchedule(list06);
  const siteWorksTasks = await buildSiteWorksTasks(list06);
  const compliance = buildCompliance(list03);

  // 4. Merge with preserved narrative
  const existing = project.existingData;
  // Format generated timestamp in Sydney time so the meeting team can see
  // exactly when the last refresh fired (date + day-of-week + time + tz).
  // Example: "Tue 8 Apr 2026 · 06:30 AEDT"
  const now = new Date();
  const sydney = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  }).formatToParts(now);
  const part = type => sydney.find(p => p.type === type)?.value || '';
  const generatedStr = `${part('weekday')} ${part('day')} ${part('month')} ${part('year')} · ${part('hour')}:${part('minute')} ${part('timeZoneName')}`;

  const lifecycle = buildLifecycle(existing.project || {}, claims, variations, schedule, siteWorksTasks);

  const newData = {
    ...existing,
    generated: generatedStr,
    metrics: recomputeMetrics(existing.metrics || {}, claims, variations, budget, siteWorksTasks),
    claims,
    variations,
    budget,
    schedule,
    siteWorksTasks,
    compliance,
    lifecycle,
    // PRESERVED (via the {...existing} spread above): project, phase, health,
    // milestoneGroups, actions, projectSummary, footer, directorRecommendation,
    // emailLog (incl. ballInCourt), and the engine reads changesSinceReview +
    // outstanding. These are engine/LLM-computed — the deterministic refresh
    // must not overwrite them; it only recomputes the numeric/data fields below.
  };

  // 5. Inject into existing HTML
  const html = fs.readFileSync(project.indexPath, 'utf8');
  let newHtml = replaceJsonBlock(html, 'project-data', newData);

  // Idempotent label upgrade — patch the legacy "Updated: " label inside the
  // dashboard's renderer template literal so existing dashboards say
  // "Data refreshed from ClickUp:" after the refresh runs. Match the exact
  // surrounding context so we don't touch any other "Updated: " string.
  newHtml = newHtml.replace(
    "'<div class=\"updated\">Updated: '+esc(D.generated)+'</div>'",
    "'<div class=\"updated\" title=\"Timestamp of the last automatic data sync from ClickUp\">Data refreshed from ClickUp: '+esc(D.generated)+'</div>'"
  );

  fs.writeFileSync(project.indexPath, newHtml, 'utf8');

  log(`  ✅ refreshed: claims=${claims.length} variations=${variations.length} budget=${budget.labour.length + budget.nonLabour.length} schedule=${schedule.length} siteWorks=${siteWorksTasks.length} compliance=${compliance.length}`);
  return {
    slug: project.slug,
    jobNumber: project.jobNumber,
    projectName: project.projectName,
    contractValue: newData.metrics.contractValue.value,
    siteWorksProgress: newData.metrics.siteWorks.value,
    counts: {
      claims: claims.length,
      variations: variations.length,
      budgetItems: budget.labour.length + budget.nonLabour.length,
      siteWorks: siteWorksTasks.length,
      compliance: compliance.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
  if (!TOKEN) {
    err('CLICKUP_API_TOKEN env var is required.');
    process.exit(2);
  }

  const rawArgs = process.argv.slice(2);
  const indexOnly = rawArgs.includes('--index-only');
  const args = rawArgs.filter(a => a !== '--index-only');
  log('args:', JSON.stringify(rawArgs));

  const allProjects = discoverProjects();
  log(`discovered ${allProjects.length} dashboards in sbi-dashboards/:`, allProjects.map(p => p.slug).join(', '));

  let activeCuFolders = [];
  let missingDashboards = [];
  let folderFetchOk = false;
  try {
    activeCuFolders = await fetchActiveClickUpFolders();
    missingDashboards = computeMissingDashboards(allProjects, activeCuFolders);
    folderFetchOk = true;
    log(`ClickUp active job folders (6-digit prefix): ${activeCuFolders.length}`);
    if (missingDashboards.length) {
      warn(`${missingDashboards.length} active ClickUp jobs have NO dashboard:`);
      missingDashboards.forEach(m => warn(`  - ${m.name} (folder ${m.id}, ${m.taskCount} tasks)`));
    } else {
      log('All active ClickUp jobs have dashboards.');
    }
  } catch (e) {
    warn(`Failed to enumerate ClickUp active folders: ${e.message}`);
  }

  if (indexOnly) {
    log('--index-only: skipping dashboard refresh, rebuilding index.html only');
    if (folderFetchOk) {
      await rebuildIndexPage(allProjects, activeCuFolders, path.join(REPO_ROOT, 'index.html'));
    } else {
      err('Cannot rebuild index — active folder fetch failed.');
      process.exit(1);
    }
    process.exit(0);
  }

  const targets = filterProjects(allProjects, args);
  log(`targets after filter (${targets.length}):`, targets.map(p => p.slug).join(', '));

  if (targets.length === 0) {
    err('No projects matched the filter.');
    process.exit(2);
  }

  const successes = [];
  const failures = [];

  for (const project of targets) {
    try {
      const result = await refreshProject(project);
      successes.push(result);
    } catch (e) {
      err(`${project.slug} failed: ${e.message}`);
      failures.push({ slug: project.slug, error: e.message });
    }
  }

  // Summary
  console.log('\n────────── SUMMARY ──────────');
  console.log(`Total: ${targets.length}  |  Success: ${successes.length}  |  Failed: ${failures.length}`);
  if (successes.length) {
    console.log('\nRefreshed:');
    for (const s of successes) {
      console.log(`  ✅ ${s.slug.padEnd(40)} contract=${s.contractValue.padEnd(12)} site=${s.siteWorksProgress}`);
    }
  }
  if (failures.length) {
    console.log('\nFailed:');
    for (const f of failures) {
      console.log(`  ❌ ${f.slug}: ${f.error}`);
    }
  }

  // Rebuild index.html so the landing page reflects current active/archived split.
  // Uses allProjects (every dashboard in the repo), not targets (the filtered subset
  // we refreshed this run), so partial refreshes don't drop cards from the index.
  if (folderFetchOk) {
    try {
      await rebuildIndexPage(allProjects, activeCuFolders, path.join(REPO_ROOT, 'index.html'));
    } catch (e) {
      warn(`Failed to rebuild index page: ${e.message}`);
    }
  } else {
    warn('Skipping index rebuild — active folder fetch failed earlier.');
  }

  // Write a summary file the GA workflow can use to post a meeting comment
  fs.writeFileSync(path.join(REPO_ROOT, '_refresh-summary.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    total: targets.length,
    successes,
    failures,
    activeCuFolders: activeCuFolders.length,
    missingDashboards,
  }, null, 2), 'utf8');

  // ─── Performance dashboard pipeline ────────────────────────
  // After the per-project refresh + index rebuild, regenerate the
  // performance page and (weekly internal / monthly external) CEO Lens
  // advice. Order matters:
  //   1. fetch-sales-data — fresh deals list
  //   2. performance      — produces performance.json (input for CEO lenses)
  //   3. ceo-internal     — self-skips if <7d old (weekly cadence)
  //   4. ceo-external     — self-skips if <28d old (monthly cadence)
  //   5. performance-final — re-render so HTML picks up any new ceo-*.json
  // Each step is isolated — failure in one does not block the others.
  await runPostProcess([
    { name: 'fetch-sales-data',  script: 'fetch-sales-data.js',     requires: ['CLICKUP_API_TOKEN'] },
    { name: 'performance',       script: 'performance.js',          requires: [] },
    { name: 'ceo-internal',      script: 'ceo-advice-internal.js',  requires: ['ANTHROPIC_API_KEY'] },
    { name: 'ceo-external',      script: 'ceo-advice.js',           requires: ['ANTHROPIC_API_KEY'] },
    { name: 'performance-final', script: 'performance.js',          requires: [] },
  ]);

  process.exit(failures.length ? 1 : 0);
}

async function runPostProcess(steps) {
  const { spawnSync } = require('child_process');
  console.log('\n────────── PERFORMANCE PIPELINE ──────────');
  for (const step of steps) {
    const missing = step.requires.filter(k => !process.env[k]);
    if (missing.length) {
      warn(`${step.name}: skipped — env var${missing.length > 1 ? 's' : ''} ${missing.join(', ')} not set`);
      continue;
    }
    const t0 = Date.now();
    log(`${step.name}: starting…`);
    try {
      const r = spawnSync(process.execPath, [path.join(REPO_ROOT, step.script)], {
        stdio: 'inherit',
        env: process.env,
        cwd: REPO_ROOT,
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (r.status === 0) {
        log(`${step.name}: ✅ ${elapsed}s`);
      } else {
        warn(`${step.name}: ⚠️ exit ${r.status} after ${elapsed}s — continuing`);
      }
    } catch (e) {
      warn(`${step.name}: ❌ spawn error — ${e.message}`);
    }
  }
}

main().catch(e => {
  err('Fatal:', e.message);
  err(e.stack);
  process.exit(1);
});

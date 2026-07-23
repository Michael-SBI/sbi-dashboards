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
 * NEW-PROJECT AUTO-CREATION (added 2026-07-23)
 * --------------------------------------------
 * When an active ClickUp job folder has no dashboard yet, this worker now SEEDS
 * one from TEMPLATE.html (vendored alongside this script) using the same
 * deterministic ClickUp pull, then refreshes + indexes it in the same run — so a
 * newly-won project gets a live dashboard on the next ~06:30 refresh instead of a
 * "SETUP PENDING" placeholder card. The seed carries the template's safe empty
 * defaults for the narrative/health fields; those are enriched later by the
 * project-health-check engine (html mode) exactly as for any existing dashboard.
 * Seeding respects the project filter (only seeds folders matching the filter, or
 * all of them on a full run), skips empty (0-task) folders, and is disabled by
 * --no-create and in --index-only mode. A folder that fails to seed falls back to
 * the SETUP PENDING card as before.
 *
 * Usage:
 *   node refresh.js                       # refresh all projects + seed any new ones
 *   node refresh.js hungry-wolfs,natural  # refresh by slug (substring match)
 *   node refresh.js 260306,260325         # refresh by job number
 *   node refresh.js --no-create           # refresh only; never seed new dashboards
 *   node refresh.js --index-only          # rebuild index.html only (no refresh/seed)
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

// Vendored copy of the project-dashboard skill's TEMPLATE.html. Used to seed a
// brand-new dashboard for an active ClickUp folder that doesn't have one yet.
// It's a plain file at the repo root (not a directory), so discoverProjects()
// ignores it. Kept in sync manually — it only needs to be structurally valid;
// the deterministic refresh + the engine repopulate the data.
const SEED_TEMPLATE_PATH = path.join(REPO_ROOT, 'TEMPLATE.html');

// Leading type keywords that may prefix a folder/deal name (e.g. "260415 BUILD
// Wyoming Medical - Door"). Longest-first so multi-word heads match before their
// prefixes. Used to split a seed's project.type from project.name.
const TYPE_HEADS = [
  'CERT & DESIGN', 'SUPPLY & INSTALL', 'DO & CHARGE',
  'BUILD', 'DESIGN', 'JOINERY', 'CERT', 'SUPPLY', 'MAINTENANCE',
];

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
      // Resolve the folder id defensively. Canonical key is `folderId`, but some
      // older/one-off dashboards stored it as `id`. Falling back here stops a valid
      // active job from silently vanishing from the index on the nightly refresh.
      const folderId = data.project?.folderId || data.project?.id || null;
      const jobNumber = data.project?.jobNumber;
      const projectName = data.project?.name;
      // A dashboard with neither a folderId nor a jobNumber can't be placed — skip it.
      // But if it has a jobNumber we KEEP it (even with folderId null) so the active/
      // archived split can still match it by job number against the live ClickUp folders.
      if (!folderId && !jobNumber) {
        warn(`${entry.name}: no folderId and no jobNumber in project-data, skipping`);
        continue;
      }
      if (!folderId) {
        warn(`${entry.name}: no folderId in project-data — will match by jobNumber ${jobNumber}`);
      }
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

// Parse the CLI filter into a list of lowercase match tokens, or null for "all".
function parseFilterTokens(args) {
  if (!args || args.length === 0 || args[0] === 'all' || args[0] === '') return null;
  const tokens = args.flatMap(a => a.split(',')).map(s => s.trim().toLowerCase()).filter(Boolean);
  return tokens.length ? tokens : null;
}

function filterProjects(projects, args) {
  const tokens = parseFilterTokens(args);
  if (!tokens) return projects;
  return projects.filter(p =>
    tokens.some(t =>
      p.slug.toLowerCase().includes(t) ||
      (p.jobNumber || '').toLowerCase().includes(t) ||
      (p.projectName || '').toLowerCase().includes(t)
    )
  );
}

// ─────────────────────────────────────────────────────────────
// NEW-PROJECT SEEDING
// ─────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Split a folder/deal name (already stripped of its 6-digit job number) into a
// { type, name } pair. "BUILD Wyoming Medical - Door" → { type: "BUILD",
// name: "Wyoming Medical - Door" }. "BUILD — Door supply..." → { type: "BUILD",
// name: "Door supply..." }. No recognised head → { type: "", name: <remainder> }.
function deriveTypeAndName(folderName) {
  const remainder = String(folderName || '').replace(/^\d{6}\s*/, '').trim();
  for (const head of TYPE_HEADS) {
    const re = new RegExp('^' + head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(remainder)) {
      const rest = remainder.slice(head.length).replace(/^\s*[—–:-]?\s*/, '').trim();
      return { type: head.toUpperCase(), name: rest || remainder };
    }
  }
  return { type: '', name: remainder };
}

function formatSoldDate(epochMs) {
  if (!epochMs) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric',
    }).formatToParts(new Date(Number(epochMs)));
    const get = t => parts.find(p => p.type === t)?.value || '';
    return `${get('day')} ${get('month')} ${get('year')}`.trim();
  } catch { return ''; }
}

// Page the Deals list once and return Map(jobNumber -> won task) for the requested
// job numbers. Only WON/SOLD tasks count — mirrors resolveSoldDates so a lost deal
// sharing a job number can't supply bogus seed metadata. Fault-tolerant: returns
// whatever it found (empty map on failure).
async function fetchWonDealsByJob(jobNumbers) {
  const want = new Set((jobNumbers || []).filter(Boolean).map(String));
  const out = new Map();
  if (!want.size) return out;
  try {
    for (let page = 0; page < 6; page++) {
      const data = await clickup(`/list/${DEALS_LIST}/task?include_closed=true&subtasks=false&page=${page}`);
      const tasks = data.tasks || [];
      for (const t of tasks) {
        const jn = (t.name.match(/(\d{6})/) || [])[1];
        if (!jn || !want.has(jn) || !isWonStatus(t.status?.status)) continue;
        if (!out.has(jn)) out.set(jn, t);
      }
      if (data.last_page) break;
    }
  } catch (e) {
    warn(`Deals-list seed lookup failed: ${e.message}`);
  }
  return out;
}

// Create a brand-new dashboard for an active ClickUp folder that has none yet.
// Writes <slug>/index.html from the seed template with a populated `project`
// block; every other section keeps the template's safe empty defaults and is
// filled by the deterministic refresh (immediately after) + the engine (later).
// Returns a project object shaped like discoverProjects() entries, or null on
// failure (caller leaves the folder as a SETUP PENDING card).
function seedNewDashboard(folder, dealTask, templateHtml, templateProjectData) {
  const jobNumber = folder.jobNumber || (folder.name.match(/(\d{6})/) || [])[1] || '';
  const { type, name } = deriveTypeAndName(folder.name);
  const displayName = name || folder.name;
  const slug = [jobNumber, slugify(displayName)].filter(Boolean).join('-') || `cu-${folder.id}`;
  const dir = path.join(REPO_ROOT, slug);
  const indexPath = path.join(dir, 'index.html');

  if (fs.existsSync(indexPath)) {
    warn(`seed: ${slug}/index.html already exists — not overwriting`);
    return null;
  }

  // Deep-clone the template's default project-data and populate the project block.
  const pd = JSON.parse(JSON.stringify(templateProjectData));
  pd.project = { ...(pd.project || {}) };
  pd.project.jobNumber = jobNumber;
  pd.project.folderId = String(folder.id);
  pd.project.name = displayName;
  pd.project.type = type;
  // Blank the template's placeholder identity fields so a seeded dashboard shows
  // empty (honest) rather than fake "Client Name" / "PM Name" until the engine
  // fills them in from the sales task + health read.
  pd.project.client = '';
  pd.project.pm = '';
  if (dealTask) {
    pd.project.salesTaskUrl = `https://app.clickup.com/t/${dealTask.id}`;
    const sold = wonDate(dealTask);
    if (sold) pd.project.dateSold = formatSoldDate(sold);
  }

  let html = replaceJsonBlock(templateHtml, 'project-data', pd);
  html = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>Project Status — ${escapeHtml(displayName)} | SBI</title>`
  );

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexPath, html, 'utf8');
  log(`  🌱 seeded new dashboard: ${slug} (folder ${folder.id}, ${folder.taskCount} tasks)`);

  return {
    slug,
    indexPath,
    folderId: pd.project.folderId,
    jobNumber,
    projectName: displayName,
    existingData: pd,
    seeded: true,
  };
}

// Seed dashboards for every active folder that has none yet (respecting the
// filter). Returns the list of newly-created project objects (empty if none).
async function seedMissingDashboards(missingDashboards, args) {
  if (!missingDashboards || !missingDashboards.length) return [];
  if (!fs.existsSync(SEED_TEMPLATE_PATH)) {
    warn(`seed template not found at ${SEED_TEMPLATE_PATH} — cannot auto-create new dashboards`);
    return [];
  }

  const filterTokens = parseFilterTokens(args);
  const candidates = missingDashboards.filter(f => {
    if (!f.jobNumber) return false;              // can't place a dashboard without a job number
    if ((f.taskCount || 0) === 0) {              // empty shell — leave as SETUP PENDING for now
      warn(`seed: skipping ${f.jobNumber} ${f.name} (0 tasks — folder not set up yet)`);
      return false;
    }
    if (!filterTokens) return true;              // full run → seed all
    return filterTokens.some(t =>
      (f.jobNumber || '').toLowerCase().includes(t) || (f.name || '').toLowerCase().includes(t)
    );
  });
  if (!candidates.length) return [];

  const templateHtml = fs.readFileSync(SEED_TEMPLATE_PATH, 'utf8');
  const tplBlock = findJsonBlock(templateHtml, 'project-data');
  if (!tplBlock) {
    warn(`seed template ${SEED_TEMPLATE_PATH} has no project-data block — cannot seed`);
    return [];
  }
  let templateProjectData;
  try {
    templateProjectData = JSON.parse(tplBlock.content);
  } catch (e) {
    warn(`seed template project-data is not valid JSON: ${e.message}`);
    return [];
  }

  log(`Seeding ${candidates.length} new dashboard(s) for active folders without one...`);
  const deals = await fetchWonDealsByJob(candidates.map(f => f.jobNumber));

  const created = [];
  for (const folder of candidates) {
    try {
      const p = seedNewDashboard(folder, deals.get(String(folder.jobNumber)), templateHtml, templateProjectData);
      if (p) created.push(p);
    } catch (e) {
      warn(`seed failed for ${folder.jobNumber} ${folder.name}: ${e.message}`);
    }
  }
  return created;
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
  // Fallback card for a live ClickUp folder that has no dashboard yet — links to the
  // ClickUp folder so the project is still present in the view (invariant), not dropped.
  if (project.fallbackFolder) {
    const f = project.fallbackFolder;
    const jn = project.jobNumber || '';
    const name = f.name.replace(/^\d{6}\s*/, '').trim() || f.name;
    const url = `https://app.clickup.com/36601479/v/f/${f.id}/${SBI_PROJECTS_SPACE}`;
    const typeLine = jn + ' - SETUP PENDING';
    return `<a class="card" href="${escapeHtml(url)}"><h2>${escapeHtml(name)}</h2><div class="type">${escapeHtml(typeLine)}</div><div class="updated">Dashboard not built yet — open in ClickUp →</div></a>`;
  }
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

  // ── THE INVARIANT ──────────────────────────────────────────────────────────
  // Every non-archived folder in the SBI PROJECTS space that carries a 6-digit job
  // number MUST appear in the Active view. So the Active section is driven by the LIVE
  // ClickUp folder list (activeCuFolders — the source of truth), NOT by which dashboards
  // happen to exist in the repo. Each active folder is matched to its dashboard by folder
  // id first (authoritative), then by job number as a fallback for a dashboard with a
  // missing/mis-keyed folderId. A folder with no dashboard yet still gets a fallback card
  // so it is never silently missing. Result: Active count == number of active job folders.
  const byFolder = new Map();
  const byJob = new Map();
  for (const p of allProjects) {
    if (p.folderId) byFolder.set(String(p.folderId), p);
    if (p.jobNumber && !byJob.has(String(p.jobNumber))) byJob.set(String(p.jobNumber), p);
  }

  const activeProjects = [];
  const matchedSlugs = new Set();
  const fallbacks = [];
  for (const f of activeCuFolders) {
    let p = byFolder.get(String(f.id));
    // Only fall back to job-number matching when no dashboard claims this folder id.
    // Job numbers are NOT unique across dashboards, but the folder-id match runs first,
    // so an archived dashboard sharing a number can't hijack a live folder that has its own.
    if (!p && f.jobNumber) p = byJob.get(String(f.jobNumber));
    if (p) {
      matchedSlugs.add(p.slug);
      activeProjects.push(p);
    } else {
      const fb = { slug: `cu-${f.id}`, folderId: String(f.id), jobNumber: f.jobNumber, projectName: f.name, fallbackFolder: f };
      activeProjects.push(fb);
      fallbacks.push(fb);
    }
  }
  if (fallbacks.length) {
    warn(`${fallbacks.length} active folder(s) have NO dashboard — rendered as SETUP PENDING cards linking to ClickUp:`);
    fallbacks.forEach(fb => warn(`  - ${fb.jobNumber} ${fb.projectName}`));
  }

  // Archived = every repo dashboard NOT matched into the active set above.
  const archivedProjects = allProjects.filter(p => !matchedSlugs.has(p.slug));

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
    firstTime: !!project.seeded,   // true when this dashboard was auto-created this run
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
  const noCreate = rawArgs.includes('--no-create');
  const args = rawArgs.filter(a => a !== '--index-only' && a !== '--no-create');
  log('args:', JSON.stringify(rawArgs));

  let allProjects = discoverProjects();
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

  // Auto-seed a dashboard for any active folder that doesn't have one yet, so a
  // newly-won project appears with live data on this run instead of a SETUP
  // PENDING placeholder. Skipped in --index-only, when --no-create is passed, or
  // if the ClickUp folder fetch failed (we can't know what's missing).
  if (folderFetchOk && !indexOnly && !noCreate) {
    try {
      const seeded = await seedMissingDashboards(missingDashboards, args);
      if (seeded.length) {
        allProjects = allProjects.concat(seeded);
        // Recompute so the summary/index no longer report the seeded ones as missing.
        missingDashboards = computeMissingDashboards(allProjects, activeCuFolders);
        log(`Seeded ${seeded.length} new dashboard(s): ${seeded.map(p => p.slug).join(', ')}`);
      }
    } catch (e) {
      warn(`New-project seeding step failed: ${e.message}`);
    }
  } else if (folderFetchOk && noCreate && missingDashboards.length) {
    log(`--no-create: leaving ${missingDashboards.length} dashboard-less folder(s) as SETUP PENDING.`);
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
  const newlyCreated = successes.filter(s => s.firstTime);
  console.log('\n────────── SUMMARY ──────────');
  console.log(`Total: ${targets.length}  |  Success: ${successes.length}  |  Failed: ${failures.length}  |  New: ${newlyCreated.length}`);
  if (successes.length) {
    console.log('\nRefreshed:');
    for (const s of successes) {
      console.log(`  ${s.firstTime ? '🌱' : '✅'} ${s.slug.padEnd(40)} contract=${s.contractValue.padEnd(12)} site=${s.siteWorksProgress}`);
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
    newDashboards: newlyCreated.map(s => ({ slug: s.slug, jobNumber: s.jobNumber, projectName: s.projectName })),
    activeCuFolders: activeCuFolders.length,
    missingDashboards,
  }, null, 2), 'utf8');

  // ─── Performance Review pipeline REMOVED 2026-07-21 ────────────────────────
  // The Performance Review dashboard (performance.html) + the nightly CEO Lens
  // (Opus 4.7, top API-credit consumer) were retired. The CEO-advice concept moves
  // to an on-demand `ceo-lens` skill surfaced on the SBI Hub — regenerated when
  // requested, in-session (on the subscription), not nightly on the paid API.
  // The deterministic data-prep scripts (fetch-sales-data.js, performance.js) are
  // KEPT for that skill to call on demand; they're just no longer run here.

  process.exit(failures.length ? 1 : 0);
}

main().catch(e => {
  err('Fatal:', e.message);
  err(e.stack);
  process.exit(1);
});

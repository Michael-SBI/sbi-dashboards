#!/usr/bin/env node
/**
 * SBI Dashboard Refresh Worker
 * ============================
 * Refreshes deterministic data (claims, budget, schedule, site works,
 * compliance, metrics) on existing project dashboards by pulling fresh
 * ClickUp data via the REST API. Narrative fields (actions, projectSummary,
 * milestoneGroups, phase) are preserved from the existing dashboard.
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
    const isVariation = /variation/i.test(t.name) || /^v\d/i.test(t.name);

    const entry = {
      num: 0,
      name: t.name,
      amount,
      pct,
      workflow: wfName,
      workflowColor: wfColor,
      status: t.status?.status || '',
      notes: '',
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
    // PRESERVED: project, phase, health, milestoneGroups, actions, projectSummary, footer
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

  const args = process.argv.slice(2);
  log('args:', JSON.stringify(args));

  const allProjects = discoverProjects();
  log(`discovered ${allProjects.length} projects:`, allProjects.map(p => p.slug).join(', '));

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

  // Write a summary file the GA workflow can use to post a meeting comment
  fs.writeFileSync(path.join(REPO_ROOT, '_refresh-summary.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    total: targets.length,
    successes,
    failures,
  }, null, 2), 'utf8');

  process.exit(failures.length ? 1 : 0);
}

main().catch(e => {
  err('Fatal:', e.message);
  err(e.stack);
  process.exit(1);
});

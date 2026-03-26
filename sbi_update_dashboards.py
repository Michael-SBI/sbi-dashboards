#!/usr/bin/env python3
"""
SBI Dashboard Auto-Updater — Webhook Server
=============================================
Runs as a background server on your machine. Make.com calls the
webhook endpoint on schedule, which triggers the full dashboard update:
ClickUp → Claude AI → Generate HTML → Zip → Deploy to Netlify.

SETUP (one-time):
  1. Install Python: python.org/downloads (tick "Add to PATH")
  2. Install dependencies: pip install anthropic requests
  3. Double-click sbi_dashboard_server.py  (or run: python sbi_dashboard_server.py)
  4. Leave it running — it listens for Make to call it

AUTO-START ON WINDOWS BOOT (optional):
  - Press Win+R → type "shell:startup" → press Enter
  - Create a shortcut to this .py file in that folder
  - Windows will run it on every login automatically

MAKE WEBHOOK URL:
  http://YOUR_IP:8765/run-dashboards
  Get your IP: https://whatismyip.com
  Or use ngrok for a stable public URL (see NGROK SETUP below)

NGROK SETUP (recommended — gives you a stable public URL):
  1. Download ngrok: ngrok.com/download
  2. Run: ngrok http 8765
  3. Copy the https://xxxx.ngrok.io URL
  4. Use that URL in your Make webhook
"""

import json
import zipfile
import io
import urllib.request
import urllib.error
import urllib.parse
import datetime
import os
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

# ─────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────

NETLIFY_TOKEN  = "nfp_fAjpxrjnrPraigiM3w3CsHjKmqdN1f2M0591"
CLICKUP_TOKEN  = "pk_48602901_PCOZVR87KBN56A7OZPUPKY7SNWG0EH1N"
ANTHROPIC_KEY  = "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"

WEBHOOK_PORT   = 8765
WEBHOOK_SECRET = "sbi-dashboard-2026"  # Make sends this as ?secret= to verify it's you

CLICKUP_API    = "https://api.clickup.com/api/v2"
NETLIFY_API    = "https://api.netlify.com/api/v1"
ANTHROPIC_API  = "https://api.anthropic.com/v1/messages"

NETLIFY_SITES = {
    "sbi-sunshine-kebabs":      "3d3ca19b-a12c-4c67-a845-55847eff8ddf",
    "sbi-bozmik-jillaby":       "be8a587a-992c-46a9-8d83-4d393b3de996",
    "sbi-extend-rehab":         "8e780f5d-70a7-4e9b-8f81-63254c51f8b9",
    "sbi-karuah-commercial":    "78602801-20f2-45e0-99fd-95029f55775a",
    "sbi-fenwicks-marina":      "7471b388-b57d-493d-8cb6-d8822d850e62",
    "sbi-pasta-emilia":         "23c94e8b-a25c-4a45-9dcc-a46452b81ba0",
    "sbi-mingara-club":         "432222d6-fb0c-41b4-acc0-87bbac2ded85",
    "sbi-nepean-power":         "9830e490-4d4d-4ff4-bca8-27741979080f",
    "sbi-erina-sawmill":        "bbfa9241-b3ed-4363-a0f2-0508b91663a3",
    "sbi-kevin-display-cabinet":"30669cd6-5eb5-4d19-9ddc-53d1157f4cb7",
    "sbi-miguel-san-roman":     "f747e9dc-08ce-403c-9a38-de3430e0f5aa",
    "sbi-lakehaven-post-office":"33f121f4-97f9-4da2-a7c4-884944aa8b88",
    "sbi-endo-water-damage":    "d7f9100f-66a9-416f-8b3d-e0796e59c846",
    "sbi-office-renovation":    None,
}

PROJECTS = [
    {"folder_id": "90167718378", "slug": "sbi-sunshine-kebabs",       "name": "Sunshine Kebabs – East Maitland",    "job": "251206", "client": "Mustafa Ozdemir",  "pm": "Chadd Hofner",  "location": "East Maitland"},
    {"folder_id": "90167179130", "slug": "sbi-bozmik-jillaby",        "name": "Bozmik – Jillaby Mezzanine",         "job": "250820", "client": "Michael Baird",    "pm": "Chadd Hofner",  "location": "Jillaby"},
    {"folder_id": "90165518502", "slug": "sbi-extend-rehab",          "name": "Extend Rehab – Coastal Physio",      "job": "240207", "client": "Extend Rehab",     "pm": "Chadd Hofner",  "location": "Erina"},
    {"folder_id": "90165261607", "slug": "sbi-karuah-commercial",     "name": "Karuah Commercial Space",            "job": "250522", "client": "Karuah",           "pm": "Michael Cook",  "location": "Karuah"},
    {"folder_id": "90167162672", "slug": "sbi-office-renovation",     "name": "SBI Office Renovation",              "job": "Internal","client": "SBI",            "pm": "Michael Cook",  "location": "SBI HQ"},
    {"folder_id": "90167386794", "slug": "sbi-fenwicks-marina",       "name": "Fenwicks Marina – Breakout Room",    "job": "251012", "client": "Fenwicks Marina",  "pm": "Chadd Hofner",  "location": "Nelson Bay"},
    {"folder_id": "90167399310", "slug": "sbi-pasta-emilia",          "name": "Pasta Emilia",                       "job": "251020", "client": "Pasta Emilia",     "pm": "Michael Cook",  "location": "Newcastle"},
    {"folder_id": "90167858259", "slug": "sbi-mingara-club",          "name": "Mingara Club – Office Fitout",       "job": "251213", "client": "Mingara Club",     "pm": "Chadd Hofner",  "location": "Tumbi Umbi"},
    {"folder_id": "90167933890", "slug": "sbi-nepean-power",          "name": "Nepean Power – Partition",           "job": "251215", "client": "Nepean Power",     "pm": "Chadd Hofner",  "location": "Penrith"},
    {"folder_id": "90167964962", "slug": "sbi-erina-sawmill",         "name": "Erina Sawmill – Office Fitout",      "job": "251210", "client": "Trent Taylor",     "pm": "Michael Cook",  "location": "Erina"},
    {"folder_id": "90168760958", "slug": "sbi-kevin-display-cabinet", "name": "Display Cabinet – Kevin Adolphus",   "job": "260210", "client": "Kevin Adolphus",   "pm": "Chadd Hofner",  "location": "TBC"},
    {"folder_id": "90168866807", "slug": "sbi-miguel-san-roman",      "name": "Miguel San Roman – Storage",         "job": "260226", "client": "Miguel San Roman", "pm": "Chadd Hofner",  "location": "Berkeley Vale"},
    {"folder_id": "90168870222", "slug": "sbi-lakehaven-post-office", "name": "Lakehaven – Post Office Design",     "job": "260304", "client": "Lakehaven SC",     "pm": "Michael Cook",  "location": "Lakehaven"},
    {"folder_id": "90169010970", "slug": "sbi-endo-water-damage",     "name": "Endo Water Damage",                  "job": "260129", "client": "Endo",             "pm": "Chadd Hofner",  "location": "TBC"},
]

TODAY = datetime.date.today().strftime("%d %B %Y").lstrip("0")

# ─────────────────────────────────────────────────────────────
# HTTP HELPERS
# ─────────────────────────────────────────────────────────────

def api_get(url, token):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f"  GET error {url}: {e}")
        return None

def api_post_json(url, headers, body_dict):
    data = json.dumps(body_dict).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  POST error {e.code}: {e.read().decode()[:300]}")
        return None

def api_post_zip(url, token, zip_bytes):
    req = urllib.request.Request(url, data=zip_bytes, method="POST", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/zip"
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  Deploy error {e.code}: {e.read().decode()[:300]}")
        return None

# ─────────────────────────────────────────────────────────────
# CLICKUP
# ─────────────────────────────────────────────────────────────

def fetch_tasks(folder_id):
    url = f"{CLICKUP_API}/folder/{folder_id}/task?include_closed=true&order_by=due_date&page=0"
    data = api_get(url, CLICKUP_TOKEN)
    return data.get("tasks", []) if data else []

def analyse_tasks(tasks):
    now_ms = datetime.datetime.now().timestamp() * 1000
    done_statuses = {"done","closed","complete","completed","1. variation approved",
                     "variation approved","ordered and recevied","certification","ordered and received"}

    schedule, compliance, financial = [], [], []
    overdue, upcoming, recent_done = [], [], []
    open_proc = 0

    for t in tasks:
        ln  = t.get("list", {}).get("name", "")
        st  = (t.get("status", {}).get("status") or "").lower()
        due = t.get("due_date")
        is_done = st in done_statuses

        if any(x in ln for x in ["06", "[Schedule]", "Schedule"]):
            if is_done:
                recent_done.append(t)
            elif due and int(due) < now_ms:
                overdue.append(t)
            else:
                upcoming.append(t)
            schedule.append(t)

        if any(x in ln for x in ["03", "Admin"]):
            compliance.append(t)

        if any(x in ln for x in ["04", "Variation", "claim", "Payment"]):
            financial.append(t)

        if any(x in ln for x in ["08", "Procurement"]):
            if not is_done and st != "closed":
                open_proc += 1

    sched_done  = sum(1 for t in schedule if (t.get("status",{}).get("status") or "").lower() in done_statuses)
    sched_total = max(len(schedule), 1)
    sched_pct   = round(sched_done / sched_total * 100)

    future = sorted([t for t in upcoming if t.get("due_date")], key=lambda t: int(t["due_date"]))
    next_days, next_label = None, "—"
    if future:
        delta = (datetime.datetime.fromtimestamp(int(future[0]["due_date"])/1000) - datetime.datetime.now()).days
        next_days  = max(0, delta)
        next_label = future[0]["name"][:35]

    comp_done  = sum(1 for t in compliance if (t.get("status",{}).get("status") or "").lower() in done_statuses)

    return {
        "sched_pct": sched_pct, "sched_done": sched_done, "sched_total": sched_total,
        "overdue": overdue[:6], "upcoming": upcoming[:8], "recent_done": recent_done[:5],
        "compliance": compliance, "comp_done": comp_done, "comp_total": len(compliance),
        "financial": financial, "open_proc": open_proc,
        "next_days": next_days, "next_label": next_label,
    }

def detect_phase(tasks):
    done = {"done","closed","complete","completed"}
    open_lists = set()
    for t in tasks:
        if (t.get("status",{}).get("status") or "").lower() not in done:
            ln = t.get("list",{}).get("name","")
            for n in ["02","07","08","09","10","06"]:
                if f"✨️{n}" in ln or (f"0{n}" in ln and "Schedule" not in ln):
                    open_lists.add(n)
    if "10" in open_lists: return "On Site"
    if "09" in open_lists: return "Manufacturing"
    if "07" in open_lists or "08" in open_lists: return "Pre-Mfg"
    if "02" in open_lists: return "Design"
    if "06" in open_lists: return "On Site"
    return "Fin. Closeout"

def health_badge(overdue_count):
    if overdue_count >= 3: return "🔴 Critical", "badge-red"
    if overdue_count >= 1: return "🟡 At risk",  "badge-yellow"
    return "🟢 On track", "badge-green"

# ─────────────────────────────────────────────────────────────
# CLAUDE AI — Generate HTML
# ─────────────────────────────────────────────────────────────

def build_task_summary(tasks):
    """Condense tasks into a compact text summary for the Claude prompt."""
    lines = []
    for t in tasks[:60]:
        name   = t.get("name","")[:60].replace('"',"'")
        status = (t.get("status",{}).get("status") or "").replace('"',"'")
        ln     = t.get("list",{}).get("name","")[:40].replace('"',"'")
        due    = t.get("due_date","")
        due_str = ""
        if due:
            try:
                due_str = datetime.datetime.fromtimestamp(int(due)/1000).strftime("%d %b")
            except:
                pass
        lines.append(f"{name} | {status} | {ln} | {due_str}")
    return "\n".join(lines)

def generate_html_via_claude(project, data, tasks, phase, health, health_class):
    task_summary = build_task_summary(tasks)

    prompt = f"""You are generating a weekly project status dashboard HTML page for SBI (Spoke Building & Interiors), a NSW commercial fitout and joinery company.

PROJECT DETAILS:
- Name: {project['name']}
- Job: {project['job']}
- Client: {project['client']}
- PM: {project['pm']}
- Location: {project['location']}
- Phase: {phase}
- Health: {health}
- Live URL: https://{project['slug']}.netlify.app/
- Last updated: {TODAY}

METRICS:
- Schedule: {data['sched_pct']}% complete ({data['sched_done']} of {data['sched_total']} tasks done)
- Overdue tasks: {len(data['overdue'])}
- Compliance certs: {data['comp_done']}/{data['comp_total']} done
- Open procurement items: {data['open_proc']}
- Next deadline: {data['next_days']} days — {data['next_label']}

CLICKUP TASKS (name | status | list | due date):
{task_summary}

Generate a complete, self-contained single HTML file for this project dashboard. Requirements:
1. Inline CSS and JS only — no external dependencies
2. Dark/light mode via prefers-color-scheme media query
3. Header with project name, job number, client, PM, health badge ({health_class}: red/yellow/green), last updated date
4. Phase progress strip: Design → Pre-Mfg → Manufacturing → On Site → Completion → Fin. Closeout (highlight: {phase})
5. 4 metric cards: Schedule %, Next deadline, Compliance certs done/total, Open procurement
6. Progress bar at {data['sched_pct']}%
7. Tabs: Schedule | Compliance | Financial | Scope | Meeting Notes
   - Schedule: show upcoming tasks (not done), overdue tasks highlighted red, recently completed
   - Compliance: tasks from lists containing 03 or Admin
   - Financial: tasks from lists containing 04, Variation, or claim
   - Scope: client, PM, job, location
   - Meeting Notes: show live URL https://{project['slug']}.netlify.app/ in a blue banner, editable date/attendees fields, notes textarea, print button
8. Professional clean design with earth tones, clean sans-serif font, subtle shadows
9. Mobile-responsive

Output ONLY the complete HTML. Start with <!DOCTYPE html>. No explanation. No markdown fences."""

    body = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 8000,
        "messages": [{"role": "user", "content": prompt}]
    }
    headers = {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
    result = api_post_json(ANTHROPIC_API, headers, body)
    if result and result.get("content"):
        html = result["content"][0].get("text", "")
        # Strip any accidental markdown fences
        if html.startswith("```"):
            html = html.split("```", 2)[-1].lstrip("html").lstrip("\n")
        if html.endswith("```"):
            html = html[:-3].rstrip()
        return html
    return None

# ─────────────────────────────────────────────────────────────
# NETLIFY DEPLOY
# ─────────────────────────────────────────────────────────────

def deploy(site_id, html, project_name):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("index.html", html)
    result = api_post_zip(
        f"{NETLIFY_API}/sites/{site_id}/deploys",
        NETLIFY_TOKEN,
        buf.getvalue()
    )
    if result and result.get("id"):
        print(f"  ✅ {project_name} → deployed")
        return True
    print(f"  ❌ {project_name} → deploy failed")
    return False

# ─────────────────────────────────────────────────────────────
# MAIN UPDATE LOOP
# ─────────────────────────────────────────────────────────────

def run_update(triggered_by="manual"):
    started = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n{'='*60}")
    print(f"SBI Dashboard Update — {started}")
    print(f"Triggered by: {triggered_by}")
    print(f"{'='*60}")

    ok = failed = skipped = 0

    for project in PROJECTS:
        slug    = project["slug"]
        name    = project["name"]
        site_id = NETLIFY_SITES.get(slug)

        print(f"\n→ {name}")

        if not site_id:
            print(f"  ⏭  No Netlify site — skipped")
            skipped += 1
            continue

        # 1. Fetch ClickUp tasks
        tasks = fetch_tasks(project["folder_id"])
        print(f"  📋 {len(tasks)} tasks fetched")

        # 2. Analyse
        data         = analyse_tasks(tasks)
        phase        = detect_phase(tasks)
        health, hcls = health_badge(len(data["overdue"]))

        # 3. Generate HTML via Claude
        print(f"  🤖 Generating HTML via Claude AI...")
        html = generate_html_via_claude(project, data, tasks, phase, health, hcls)

        if not html:
            print(f"  ❌ Claude AI generation failed")
            failed += 1
            continue

        # 4. Deploy to Netlify
        success = deploy(site_id, html, name)
        if success:
            ok += 1
        else:
            failed += 1

    print(f"\n{'='*60}")
    print(f"Done: {ok} updated · {failed} failed · {skipped} skipped")
    print(f"{'='*60}\n")
    return {"updated": ok, "failed": failed, "skipped": skipped}

# ─────────────────────────────────────────────────────────────
# WEBHOOK SERVER
# ─────────────────────────────────────────────────────────────

class WebhookHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Clean log output
        print(f"  [{datetime.datetime.now().strftime('%H:%M:%S')}] {format % args}")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        # Health check
        if parsed.path == "/health":
            self._respond(200, {"status": "running", "time": str(datetime.datetime.now())})
            return

        # Dashboard update trigger
        if parsed.path == "/run-dashboards":
            # Verify secret
            secret = params.get("secret", [""])[0]
            if secret != WEBHOOK_SECRET:
                self._respond(401, {"error": "Invalid secret"})
                print("  ⚠️  Rejected request — invalid secret")
                return

            # Respond immediately so Make doesn't time out
            self._respond(200, {"status": "accepted", "message": "Dashboard update started"})

            # Run update in background thread
            trigger = params.get("trigger", ["make-webhook"])[0]
            thread = threading.Thread(target=run_update, args=(trigger,), daemon=True)
            thread.start()
            return

        self._respond(404, {"error": "Not found"})

    def do_POST(self):
        # Also accept POST (Make can send either)
        self.do_GET()

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

# ─────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────

def main():
    # Check for command line flags
    if "--run-now" in sys.argv:
        # Direct run mode (no server)
        run_update("command-line")
        return

    # Start webhook server
    server = HTTPServer(("0.0.0.0", WEBHOOK_PORT), WebhookHandler)

    print("=" * 60)
    print("SBI Dashboard Webhook Server")
    print("=" * 60)
    print(f"Listening on port {WEBHOOK_PORT}")
    print(f"")
    print(f"Endpoints:")
    print(f"  GET /health                  — health check")
    print(f"  GET /run-dashboards?secret={WEBHOOK_SECRET}")
    print(f"                               — trigger dashboard update")
    print(f"")
    print(f"Make.com webhook URL:")
    print(f"  http://YOUR_IP:{WEBHOOK_PORT}/run-dashboards?secret={WEBHOOK_SECRET}")
    print(f"")
    print(f"Find your IP at: https://whatismyip.com")
    print(f"Or use ngrok: ngrok http {WEBHOOK_PORT}")
    print(f"")
    print(f"To run dashboards right now:")
    print(f"  python sbi_dashboard_server.py --run-now")
    print(f"")
    print("Waiting for Make webhook... (Ctrl+C to stop)")
    print("=" * 60)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")

if __name__ == "__main__":
    main()

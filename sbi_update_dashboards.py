#!/usr/bin/env python3
"""
SBI Dashboard Auto-Updater
===========================
Pulls live data from ClickUp, generates HTML dashboards for all active
projects, and deploys them to Netlify automatically.

Run manually:  python sbi_update_dashboards.py
GitHub Actions runs this every Monday 7am AEST (Sunday 9pm UTC).
"""

import json, zipfile, io, urllib.request, urllib.error, datetime, os, sys

NETLIFY_TOKEN = os.environ.get("NETLIFY_TOKEN", "nfp_fAjpxrjnrPraigiM3w3CsHjKmqdN1f2M0591")
CLICKUP_TOKEN = os.environ.get("CLICKUP_TOKEN", "pk_48602901_PCOZVR87KBN56A7OZPUPKY7SNWG0EH1N")
CLICKUP_API   = "https://api.clickup.com/api/v2"
NETLIFY_API   = "https://api.netlify.com/api/v1"

NETLIFY_SITES = {
    "sbi-sunshine-kebabs":       "3d3ca19b-a12c-4c67-a845-55847eff8ddf",
    "sbi-bozmik-jillaby":        "be8a587a-992c-46a9-8d83-4d393b3de996",
    "sbi-extend-rehab":          "8e780f5d-70a7-4e9b-8f81-63254c51f8b9",
    "sbi-karuah-commercial":     "78602801-20f2-45e0-99fd-95029f55775a",
    "sbi-office-renovation":     None,
    "sbi-fenwicks-marina":       "7471b388-b57d-493d-8cb6-d8822d850e62",
    "sbi-pasta-emilia":          "23c94e8b-a25c-4a45-9dcc-a46452b81ba0",
    "sbi-mingara-club":          "432222d6-fb0c-41b4-acc0-87bbac2ded85",
    "sbi-nepean-power":          "9830e490-4d4d-4ff4-bca8-27741979080f",
    "sbi-erina-sawmill":         "bbfa9241-b3ed-4363-a0f2-0508b91663a3",
    "sbi-kevin-display-cabinet": "30669cd6-5eb5-4d19-9ddc-53d1157f4cb7",
    "sbi-miguel-san-roman":      "f747e9dc-08ce-403c-9a38-de3430e0f5aa",
    "sbi-lakehaven-post-office": "33f121f4-97f9-4da2-a7c4-884944aa8b88",
    "sbi-endo-water-damage":     "d7f9100f-66a9-416f-8b3d-e0796e59c846",
}

PROJECTS = [
    {"folder_id": "90167718378", "slug": "sbi-sunshine-kebabs",       "name": "Sunshine Kebabs",       "job": "251206", "client": "Mustafa Ozdemir",  "pm": "Chadd Hofner",  "location": "East Maitland"},
    {"folder_id": "90167179130", "slug": "sbi-bozmik-jillaby",        "name": "Bozmik Jillaby",         "job": "250820", "client": "Michael Baird",    "pm": "Chadd Hofner",  "location": "Jillaby"},
    {"folder_id": "90165518502", "slug": "sbi-extend-rehab",          "name": "Extend Rehab",           "job": "240207", "client": "Extend Rehab",     "pm": "Chadd Hofner",  "location": "Erina"},
    {"folder_id": "90165261607", "slug": "sbi-karuah-commercial",     "name": "Karuah Commercial",      "job": "250522", "client": "Karuah",           "pm": "Michael Cook",  "location": "Karuah"},
    {"folder_id": "90167162672", "slug": "sbi-office-renovation",     "name": "SBI Office Renovation",  "job": "Internal","client": "SBI",            "pm": "Michael Cook",  "location": "SBI HQ"},
    {"folder_id": "90167386794", "slug": "sbi-fenwicks-marina",       "name": "Fenwicks Marina",        "job": "251012", "client": "Fenwicks Marina",  "pm": "Chadd Hofner",  "location": "Nelson Bay"},
    {"folder_id": "90167399310", "slug": "sbi-pasta-emilia",          "name": "Pasta Emilia",           "job": "251020", "client": "Pasta Emilia",     "pm": "Michael Cook",  "location": "Newcastle"},
    {"folder_id": "90167858259", "slug": "sbi-mingara-club",          "name": "Mingara Club",           "job": "251213", "client": "Mingara Club",     "pm": "Chadd Hofner",  "location": "Tumbi Umbi"},
    {"folder_id": "90167933890", "slug": "sbi-nepean-power",          "name": "Nepean Power",           "job": "251215", "client": "Nepean Power",     "pm": "Chadd Hofner",  "location": "Penrith"},
    {"folder_id": "90167964962", "slug": "sbi-erina-sawmill",         "name": "Erina Sawmill",          "job": "251210", "client": "Trent Taylor",     "pm": "Michael Cook",  "location": "Erina"},
    {"folder_id": "90168760958", "slug": "sbi-kevin-display-cabinet", "name": "Display Cabinet Kevin",  "job": "260210", "client": "Kevin Adolphus",   "pm": "Chadd Hofner",  "location": "TBC"},
    {"folder_id": "90168866807", "slug": "sbi-miguel-san-roman",      "name": "Miguel San Roman",       "job": "260226", "client": "Miguel San Roman", "pm": "Chadd Hofner",  "location": "Berkeley Vale"},
    {"folder_id": "90168870222", "slug": "sbi-lakehaven-post-office", "name": "Lakehaven Post Office",  "job": "260304", "client": "Lakehaven SC",     "pm": "Michael Cook",  "location": "Lakehaven"},
    {"folder_id": "90169010970", "slug": "sbi-endo-water-damage",     "name": "Endo Water Damage",      "job": "260129", "client": "Endo",             "pm": "Chadd Hofner",  "location": "TBC"},
]

TODAY = datetime.date.today().strftime("%d %B %Y").lstrip("0")


def api_get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f"  GET error: {e}")
        return None


def api_post_zip(url, token, zip_bytes):
    req = urllib.request.Request(url, data=zip_bytes, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/zip"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  Deploy error {e.code}: {e.read().decode()[:200]}")
        return None


def fetch_tasks(folder_id):
    url = f"{CLICKUP_API}/folder/{folder_id}/task?include_closed=true&order_by=due_date&page=0"
    data = api_get(url, CLICKUP_TOKEN)
    return data.get("tasks", []) if data else []


def analyse(tasks):
    now_ms = datetime.datetime.now().timestamp() * 1000
    done = {"done","closed","complete","completed","1. variation approved","variation approved",
            "ordered and recevied","ordered and received","certification"}
    sch, comp, fin, ov, up, dn = [], [], [], [], [], []
    proc = 0
    for t in tasks:
        ln = t.get("list", {}).get("name", "")
        s  = (t.get("status", {}).get("status") or "").lower()
        isd = s in done
        if any(["06" in ln, "[Schedule]" in ln, "schedule" in ln.lower()]):
            if isd: dn.append(t)
            elif t.get("due_date") and int(t["due_date"]) < now_ms: ov.append(t)
            else: up.append(t)
            sch.append(t)
        if any(["03" in ln, "Admin" in ln]): comp.append(t)
        if any(["04" in ln, "Variation" in ln, "claim" in ln.lower()]): fin.append(t)
        if any(["08" in ln, "Procurement" in ln]) and not isd: proc += 1
    sd  = len([t for t in sch if (t.get("status",{}).get("status") or "").lower() in done])
    st  = max(len(sch), 1)
    pct = round(sd / st * 100)
    cd  = len([t for t in comp if (t.get("status",{}).get("status") or "").lower() in done])
    fut = sorted([t for t in up if t.get("due_date")], key=lambda x: int(x["due_date"]))
    nd = nl = None
    if fut:
        nd = max(0, round((int(fut[0]["due_date"]) / 1000 - datetime.datetime.now().timestamp()) / 86400))
        nl = fut[0]["name"][:30]
    return {"pct":pct,"sd":sd,"st":st,"ov":ov[:6],"up":up[:8],"dn":dn[:5],
            "comp":comp,"cd":cd,"ct":len(comp),"fin":fin,"proc":proc,"nd":nd,"nl":nl}


def get_phase(tasks):
    done = {"done","closed","complete","completed"}
    ol = set(t.get("list",{}).get("name","") for t in tasks
             if (t.get("status",{}).get("status") or "").lower() not in done)
    if any("10" in l for l in ol): return "On Site"
    if any("09" in l for l in ol): return "Manufacturing"
    if any("07" in l or "08" in l for l in ol): return "Pre-Manufacture"
    if any("02" in l for l in ol): return "Design"
    return "Fin. Closeout"


def get_health(ov_count):
    if ov_count >= 3: return "Critical", "badge-red"
    if ov_count >= 1: return "At risk",  "badge-yellow"
    return "On track", "badge-green"


def fmtd(ds):
    if not ds: return ""
    try: return datetime.datetime.fromtimestamp(int(ds)/1000).strftime("%d %b").lstrip("0")
    except: return ""


def sbadge(s):
    s = (s or "").lower()
    if s in {"done","closed","complete","completed","ordered and recevied","certification"}: return "s-done","done"
    if s in {"in progress","work in progress","work-in-progress","scheduled","contractor"}:  return "s-ip","in progress"
    if s in {"progress claims","payment"}:                                                   return "s-cl",s
    if s in {"variation approved","1. variation approved"}:                                  return "s-var","approved"
    return "s-todo", s or "to do"


def trows(tasks, ov=False):
    if not tasks: return '<div style="color:var(--text3);padding:6px 0;font-size:13px">None</div>'
    rows = []
    for t in tasks[:8]:
        n = t.get("name","")[:55]
        s = (t.get("status",{}).get("status") or "")
        c,l = sbadge(s)
        if ov: c,l = "s-ov","overdue"
        d = fmtd(t.get("due_date"))
        dh = f'<span style="font-size:11px;color:var(--text3)">{d}</span>' if d else ""
        rows.append(f'<div class="tr{" ov" if ov else ""}"><span class="tr-name">{n}</span>'
                    f'<div class="tr-r"><span class="st {c}">{l}</span>{dh}</div></div>')
    return "\n".join(rows)


def crows(tasks):
    if not tasks: return '<div style="color:var(--text3)">None</div>'
    rows = []
    for t in tasks[:20]:
        n = t.get("name","")[:60]
        s = (t.get("status",{}).get("status") or "")
        c,l = sbadge(s)
        rows.append(f'<div class="cr"><span class="cr-n">{n}</span><span class="st {c}">{l}</span></div>')
    return "\n".join(rows)


def phase_strip(ph):
    phs = ["Design","Pre-Mfg","Manufacturing","On Site","Completion","Fin. Closeout"]
    pm  = {"Design":0,"Pre-Manufacture":1,"Pre-Mfg":1,"Manufacturing":2,
           "On Site":3,"Completion":4,"Fin. Closeout":5}
    idx = pm.get(ph, 3)
    parts = []
    for i,p in enumerate(phs):
        ar = '<span class="ph-arrow">&rsaquo;</span>' if i < len(phs)-1 else ""
        if i < idx:    parts.append(f'<span class="ph ph-done">&#10003; {p}</span>{ar}')
        elif i == idx: parts.append(f'<span class="ph ph-active">&#9654; {p}</span>{ar}')
        else:          parts.append(f'<span class="ph ph-pending">{p}</span>{ar}')
    return "".join(parts)


CSS = (":root{--bg:#fff;--bg2:#f5f5f3;--bg3:#eeede8;--text:#1a1a18;--text2:#6b6b67;--text3:#9b9b96;"
       "--border:rgba(0,0,0,.10);--green-bg:#eaf3de;--green-text:#3b6d11;--blue-bg:#e6f1fb;"
       "--blue-text:#185fa5;--amber-bg:#faeeda;--amber-text:#633806;--red-bg:#fcebeb;"
       "--red-text:#a32d2d;--purple-bg:#eeedfe;--purple-text:#3c3489;--teal-bg:#e1f5ee;"
       "--teal-text:#0f6e56;--radius:8px;--radius-lg:12px}"
       "@media(prefers-color-scheme:dark){:root{--bg:#1c1c1a;--bg2:#252522;--bg3:#2e2e2b;"
       "--text:#f0ede8;--text2:#a8a8a2;--text3:#6e6e68;--border:rgba(255,255,255,.10);"
       "--green-bg:#173404;--green-text:#c0dd97;--blue-bg:#042c53;--blue-text:#85b7eb;"
       "--amber-bg:#412402;--amber-text:#fac775;--red-bg:#501313;--red-text:#f09595;"
       "--purple-bg:#26215c;--purple-text:#afa9ec;--teal-bg:#04342c;--teal-text:#5dcaa5}}"
       "*{box-sizing:border-box;margin:0;padding:0}"
       "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"
       "background:var(--bg3);color:var(--text);font-size:14px;line-height:1.5}"
       ".page{max-width:960px;margin:0 auto;padding:24px 16px 48px}"
       ".header{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px 24px;margin-bottom:14px}"
       ".header-top{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:8px}"
       ".proj-title{font-size:22px;font-weight:600}"
       ".proj-meta{font-size:12px;color:var(--text2);display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}"
       ".badge{font-size:12px;font-weight:500;padding:4px 12px;border-radius:20px}"
       ".badge-red{background:var(--red-bg);color:var(--red-text)}"
       ".badge-yellow{background:var(--amber-bg);color:var(--amber-text)}"
       ".badge-green{background:var(--green-bg);color:var(--green-text)}"
       ".updated{font-size:11px;color:var(--text3);margin-top:6px}"
       ".phase-track{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 20px;margin-bottom:14px}"
       ".phase-lbl{font-size:11px;font-weight:500;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}"
       ".phases{display:flex;align-items:center;overflow-x:auto;flex-wrap:wrap;gap:4px}"
       ".ph{font-size:12px;padding:5px 10px;border-radius:var(--radius);white-space:nowrap;font-weight:500}"
       ".ph-done{background:#c0dd97;color:#27500a}.ph-active{background:#b5d4f4;color:#0c447c}"
       ".ph-pending{background:var(--bg2);color:var(--text3);font-weight:400}"
       ".ph-arrow{font-size:12px;color:var(--text3);padding:0 4px}"
       ".metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}"
       ".mc{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:12px 16px}"
       ".mc-l{font-size:11px;color:var(--text2);margin-bottom:3px}"
       ".mc-v{font-size:22px;font-weight:600;color:var(--text)}"
       ".mc-s{font-size:11px;color:var(--text2);margin-top:2px}"
       ".mc-warn .mc-v{color:var(--red-text)}"
       ".pbar{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 20px;margin-bottom:14px}"
       ".pbar-hdr{display:flex;justify-content:space-between;margin-bottom:8px;font-size:12px;color:var(--text2)}"
       ".pbar-hdr strong{color:var(--text)}"
       ".pbar-bg{background:var(--bg3);border-radius:4px;height:7px}"
       ".pbar-fill{background:#1d9e75;border-radius:4px;height:7px}"
       ".tabs-wrap{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden}"
       ".tab-nav{display:flex;border-bottom:1px solid var(--border);overflow-x:auto;background:var(--bg2)}"
       ".tab-btn{padding:11px 16px;font-size:13px;font-weight:500;cursor:pointer;color:var(--text2);"
       "border:none;background:transparent;white-space:nowrap;border-bottom:2px solid transparent;margin-bottom:-1px}"
       ".tab-btn.active{color:var(--text);border-bottom-color:#185fa5;background:var(--bg)}"
       ".tab-content{padding:20px}.panel{display:none}.panel.active{display:block}"
       ".sec{font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.07em;margin:0 0 8px}"
       ".tl{display:flex;flex-direction:column;gap:5px;margin-bottom:16px}"
       ".tr{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;"
       "background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);gap:6px}"
       ".tr.ov{background:var(--red-bg);border-color:rgba(162,45,45,.2)}"
       ".tr-name{font-size:13px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
       ".tr.ov .tr-name{color:var(--red-text)}"
       ".tr-r{display:flex;align-items:center;gap:6px;flex-shrink:0}"
       ".st{font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;white-space:nowrap}"
       ".s-done{background:var(--green-bg);color:var(--green-text)}"
       ".s-ip{background:var(--blue-bg);color:var(--blue-text)}"
       ".s-todo{background:var(--bg2);color:var(--text2);border:1px solid var(--border)}"
       ".s-ov{background:var(--red-bg);color:var(--red-text)}"
       ".s-var{background:var(--teal-bg);color:var(--teal-text)}"
       ".s-cl{background:var(--purple-bg);color:var(--purple-text)}"
       ".card{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 18px;margin-bottom:10px}"
       ".card-title{font-size:14px;font-weight:600;margin-bottom:10px}"
       ".cr{display:flex;align-items:center;justify-content:space-between;padding:7px 0;"
       "border-bottom:1px solid var(--border);gap:8px}.cr:last-child{border-bottom:none}"
       ".cr-n{font-size:12px;flex:1}"
       ".sg{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}"
       ".sf{background:var(--bg2);border-radius:var(--radius);padding:9px 12px}"
       ".sf-l{font-size:11px;color:var(--text2);margin-bottom:2px}"
       ".sf-v{font-size:13px;font-weight:500}"
       ".live-banner{background:var(--blue-bg);border:1px solid rgba(24,95,165,.2);"
       "border-radius:var(--radius-lg);padding:12px 16px;margin-bottom:14px}"
       ".live-banner a{color:var(--blue-text);font-weight:600;font-size:14px}"
       ".note-area{width:100%;min-height:100px;background:var(--bg2);border:1px solid var(--border);"
       "border-radius:var(--radius);padding:10px 12px;font-size:13px;color:var(--text);"
       "font-family:inherit;resize:vertical;outline:none;margin-bottom:12px}"
       ".print-btn{padding:9px 18px;background:#185fa5;color:#fff;border:none;"
       "border-radius:var(--radius);font-size:13px;font-weight:500;cursor:pointer}"
       "@media print{.tab-nav{display:none}.panel{display:block!important}.print-btn{display:none}}"
       "@media(max-width:600px){.metrics{grid-template-columns:1fr 1fr}.sg{grid-template-columns:1fr}}")


def mkhtml(proj, d, ph, h, hc):
    sl = proj["slug"]; nm = proj["name"]; jo = proj["job"]
    cl = proj["client"]; pm = proj["pm"]; lo = proj["location"]
    url = f"https://{sl}.netlify.app/"
    dc = "mc-warn" if d["nd"] is not None and d["nd"] <= 7 else ""
    cc = "mc-warn" if d["ct"] > 0 and d["cd"] < d["ct"] * 0.4 else ""
    nd_val = "&mdash;" if d["nd"] is None else f"{d['nd']}d"
    nl_val = (d["nl"] or "")[:25]
    comp_status = "all done" if d["cd"] == d["ct"] else f"{d['ct']-d['cd']} in flight"

    return (f'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{nm} | SBI Dashboard</title><style>{CSS}</style></head><body>'
            f'<div class="page">'
            f'<div class="header"><div class="header-top"><div>'
            f'<div class="proj-title">{nm}</div>'
            f'<div class="proj-meta"><span>{jo}</span><span>&middot;</span><span>{lo}</span>'
            f'<span>&middot;</span><span>Client: {cl}</span><span>&middot;</span><span>PM: {pm}</span></div>'
            f'</div><span class="badge {hc}">{h}</span></div>'
            f'<div class="updated">Last updated: {TODAY} &middot; SBI Auto-Updater &middot; '
            f'<a href="{url}" style="color:var(--blue-text);font-size:11px" target="_blank">{sl}.netlify.app</a>'
            f'</div></div>'
            f'<div class="phase-track"><div class="phase-lbl">Project phase</div>'
            f'<div class="phases">{phase_strip(ph)}</div></div>'
            f'<div class="metrics">'
            f'<div class="mc"><div class="mc-l">Schedule</div><div class="mc-v">{d["pct"]}%</div>'
            f'<div class="mc-s">{d["sd"]} of {d["st"]} done</div></div>'
            f'<div class="mc {dc}"><div class="mc-l">Next deadline</div><div class="mc-v">{nd_val}</div>'
            f'<div class="mc-s">{nl_val}</div></div>'
            f'<div class="mc {cc}"><div class="mc-l">Compliance certs</div>'
            f'<div class="mc-v">{d["cd"]}/{d["ct"]}</div><div class="mc-s">{comp_status}</div></div>'
            f'<div class="mc"><div class="mc-l">Open procurement</div><div class="mc-v">{d["proc"]}</div>'
            f'<div class="mc-s">items active</div></div></div>'
            f'<div class="pbar"><div class="pbar-hdr"><span>Build schedule progress</span>'
            f'<strong>{d["pct"]}% complete</strong></div>'
            f'<div class="pbar-bg"><div class="pbar-fill" style="width:{d["pct"]}%"></div></div></div>'
            f'<div class="tabs-wrap"><div class="tab-nav">'
            f'<button class="tab-btn active" onclick="st('sc',this)">Schedule</button>'
            f'<button class="tab-btn" onclick="st('co',this)">Compliance</button>'
            f'<button class="tab-btn" onclick="st('fi',this)">Financial</button>'
            f'<button class="tab-btn" onclick="st('sp',this)">Scope</button>'
            f'<button class="tab-btn" onclick="st('mt',this)">Meeting Notes</button>'
            f'</div><div class="tab-content">'
            f'<div id="tab-sc" class="panel active">'
            f'<div class="sec">Overdue</div><div class="tl">{trows(d["ov"], True)}</div>'
            f'<div class="sec">Active &amp; upcoming</div><div class="tl">{trows(d["up"])}</div>'
            f'<div class="sec" style="margin-top:12px">Recently completed</div>'
            f'<div class="tl">{trows(d["dn"])}</div></div>'
            f'<div id="tab-co" class="panel"><div class="card">'
            f'<div class="card-title">Compliance &amp; certification tracker</div>'
            f'{crows(d["comp"])}</div></div>'
            f'<div id="tab-fi" class="panel"><div class="card">'
            f'<div class="card-title">Progress claims &amp; variations</div>'
            f'{crows(d["fin"])}</div></div>'
            f'<div id="tab-sp" class="panel"><div class="sg">'
            f'<div class="sf"><div class="sf-l">Client</div><div class="sf-v">{cl}</div></div>'
            f'<div class="sf"><div class="sf-l">PM</div><div class="sf-v">{pm}</div></div>'
            f'<div class="sf"><div class="sf-l">Job</div><div class="sf-v">{jo}</div></div>'
            f'<div class="sf"><div class="sf-l">Location</div><div class="sf-v">{lo}</div></div>'
            f'</div></div>'
            f'<div id="tab-mt" class="panel">'
            f'<div class="live-banner">'
            f'<div style="font-size:12px;color:var(--blue-text);font-weight:500;margin-bottom:4px">Live dashboard link</div>'
            f'<a href="{url}" target="_blank">{url}</a>'
            f'<div style="font-size:12px;color:var(--blue-text);opacity:.8;margin-top:4px">'
            f'Auto-updates every Monday 7am AEST via GitHub Actions + Make.</div></div>'
            f'<div class="sg" style="margin-bottom:14px">'
            f'<div class="sf"><div class="sf-l">Date</div>'
            f'<div style="font-size:13px;outline:none;border-bottom:1px dashed var(--border)" contenteditable="true">Click to add</div></div>'
            f'<div class="sf"><div class="sf-l">Attendees</div>'
            f'<div style="font-size:13px;outline:none;border-bottom:1px dashed var(--border)" contenteditable="true">Click to add</div></div>'
            f'</div>'
            f'<textarea class="note-area" placeholder="Notes &amp; decisions..."></textarea>'
            f'<textarea class="note-area" style="min-height:70px" placeholder="Actions agreed..."></textarea>'
            f'<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>'
            f'</div></div></div></div>'
            f'<script>function st(id,el){{document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));'
            f'document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));'
            f'document.getElementById("tab-"+id).classList.add("active");el.classList.add("active")}}</script>'
            f'</body></html>')


def deploy(site_id, html, name):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("index.html", html)
    r = api_post_zip(f"{NETLIFY_API}/sites/{site_id}/deploys", NETLIFY_TOKEN, buf.getvalue())
    if r and r.get("id"):
        print(f"  OK: {name}")
        return True
    print(f"  FAIL: {name}")
    return False


def main():
    print("=" * 60)
    print(f"SBI Dashboard Auto-Updater | {TODAY}")
    print("=" * 60)
    ok = failed = skipped = 0
    for p in PROJECTS:
        sid = NETLIFY_SITES.get(p["slug"])
        print(f"\n-> {p['name']}")
        if not sid:
            print("  Skipped - no Netlify site")
            skipped += 1
            continue
        tasks = fetch_tasks(p["folder_id"])
        print(f"  {len(tasks)} tasks fetched")
        d  = analyse(tasks)
        ph = get_phase(tasks)
        h, hc = get_health(len(d["ov"]))
        html = mkhtml(p, d, ph, h, hc)
        if deploy(sid, html, p["name"]): ok += 1
        else: failed += 1
    print(f"\n{'='*60}")
    print(f"Done: {ok} updated / {failed} failed / {skipped} skipped")
    print("=" * 60)


if __name__ == "__main__":
    main()

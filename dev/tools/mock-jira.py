"""Mock Jira for testing QA Buddy without a real Jira site. FOR TESTING ONLY.

Implements the few Jira Cloud REST API v2 endpoints QA Buddy uses, with the
same rules that commonly trip up integrations:
  - Basic auth (any email, API token must be "test-token")
  - project HACK with issue types Bug and Task
  - POSTs carrying browser cookies are rejected with "XSRF check failed"
  - attachments require the header X-Atlassian-Token: no-check

Projects: HACK (default assignee = Project Lead, unassigned not allowed),
          NOSCR (no assignee field on the create screen)
Users:    Test User (you), Project Lead, Omar Khaled

Run:   python3 tools/mock-jira.py          (listens on http://localhost:8090)
Settings in QA Buddy: site http://localhost:8090, any email, token test-token, project HACK
Created issues can be viewed at http://localhost:8090/browse/HACK-1
"""
import base64, cgi, html, io, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ISSUES = {}
TYPES = [{"name": "Bug", "subtask": False}, {"name": "Task", "subtask": False}]
# HACK: normal project, default assignee = project lead, unassigned not allowed
# NOSCR: assignee field is not on the create screen (assign after create)
PROJECTS = {
    "HACK": {"key": "HACK", "name": "Hackathon", "issueTypes": TYPES, "lead": "acc-lead", "allowUnassigned": False, "assigneeOnScreen": True},
    "NOSCR": {"key": "NOSCR", "name": "No Screen", "issueTypes": TYPES, "lead": "acc-lead", "allowUnassigned": True, "assigneeOnScreen": False},
}
USERS = {
    "acc-me": {"accountId": "acc-me", "displayName": "Test User", "emailAddress": "test@example.com"},
    "acc-lead": {"accountId": "acc-lead", "displayName": "Project Lead", "emailAddress": "lead@example.com"},
    "acc-omar": {"accountId": "acc-omar", "displayName": "Omar Khaled", "emailAddress": "omar@example.com"},
}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            return False
        email, _, token = base64.b64decode(auth[6:]).decode().partition(":")
        return bool(email) and token == "test-token"

    def do_GET(self):
        if self.path.startswith("/browse/"):
            return self.browse(self.path.split("/")[-1])
        if not self.authorized():
            return self.send_json(401, {"errorMessages": ["Client must be authenticated"]})
        if self.path == "/rest/api/2/myself":
            return self.send_json(200, USERS["acc-me"])
        if self.path.startswith("/rest/api/2/user/assignable/search"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query).get("query", [""])[0].lower()
            return self.send_json(200, [u for u in USERS.values() if q in u["displayName"].lower() or q in u["emailAddress"]])
        if self.path.startswith("/rest/api/2/issue/"):
            key = self.path.split("?")[0].rsplit("/", 1)[-1]
            if key not in ISSUES:
                return self.send_json(404, {"errorMessages": ["Issue does not exist or you do not have permission to see it."]})
            return self.send_json(200, {"key": key, "fields": {"summary": ISSUES[key]["fields"]["summary"], "status": {"name": "To Do"}}})
        if self.path == "/rest/api/2/project":
            return self.send_json(200, [{"key": p["key"], "name": p["name"]} for p in PROJECTS.values()])
        if self.path.startswith("/rest/api/2/project/"):
            key = self.path.rsplit("/", 1)[-1]
            if key not in PROJECTS:
                return self.send_json(404, {"errorMessages": [f"No project could be found with key '{key}'."]})
            return self.send_json(200, PROJECTS[key])
        self.send_json(404, {"errorMessages": ["Not found"]})

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {"errorMessages": ["Client must be authenticated"]})
        if self.headers.get("Cookie") and self.headers.get("X-Atlassian-Token") != "no-check":
            return self.send_json(403, {"errorMessages": ["XSRF check failed"]})
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)

        if self.method_put_assignee(raw):
            return
        if self.path == "/rest/api/2/issue":
            fields = json.loads(raw).get("fields", {})
            errors = {}
            project = PROJECTS.get(fields.get("project", {}).get("key"))
            if not project:
                return self.send_json(400, {"errorMessages": [], "errors": {"project": "valid project is required"}})
            if fields.get("issuetype", {}).get("name") not in [t["name"] for t in project["issueTypes"]]:
                errors["issuetype"] = "valid issue type is required"
            if "assignee" in fields:
                a = fields["assignee"]
                if not project["assigneeOnScreen"]:
                    errors["assignee"] = "Field 'assignee' cannot be set. It is not on the appropriate screen, or unknown."
                elif a is None or a.get("accountId") is None:
                    if not project["allowUnassigned"]:
                        errors["assignee"] = "Issues must be assigned."
                elif a.get("accountId") not in USERS:
                    errors["assignee"] = "User does not exist or cannot be assigned."
            if not fields.get("summary"):
                errors["summary"] = "You must specify a summary of the issue."
            if errors:
                return self.send_json(400, {"errorMessages": [], "errors": errors})
            key = f"{project['key']}-{len(ISSUES) + 1}"
            if "assignee" in fields:
                assigned = (fields["assignee"] or {}).get("accountId")
            else:
                assigned = project["lead"]  # the project's default rule
            ISSUES[key] = {"fields": fields, "attachments": [], "assignee": assigned, "notified": [assigned] if assigned else []}
            return self.send_json(201, {"id": str(10000 + len(ISSUES)), "key": key, "self": f"http://localhost:8090/rest/api/2/issue/{key}"})

        if self.path.endswith("/comment"):
            key = self.path.split("/")[-2]
            if key not in ISSUES:
                return self.send_json(404, {"errorMessages": ["Issue does not exist or you do not have permission to see it."]})
            ISSUES[key].setdefault("comments", []).append(json.loads(raw)["body"])
            return self.send_json(201, {"id": str(len(ISSUES[key]["comments"]))})

        if self.path.endswith("/attachments"):
            if self.headers.get("X-Atlassian-Token") != "no-check":
                return self.send_json(403, {"errorMessages": ["XSRF check failed"]})
            key = self.path.split("/")[-2]
            if key not in ISSUES:
                return self.send_json(404, {"errorMessages": ["Issue does not exist"]})
            form = cgi.FieldStorage(fp=io.BytesIO(raw), headers=self.headers, environ={"REQUEST_METHOD": "POST"})
            items = form["file"] if isinstance(form["file"], list) else [form["file"]]
            for item in items:
                ISSUES[key]["attachments"].append({"filename": item.filename, "type": item.type, "data": item.value})
            return self.send_json(200, [{"filename": i["filename"], "size": len(i["data"])} for i in ISSUES[key]["attachments"]])

        self.send_json(404, {"errorMessages": ["Not found"]})

    def do_PUT(self):
        self.do_POST()

    def method_put_assignee(self, raw):
        if self.command != "PUT" or not self.path.endswith("/assignee"):
            return False
        key = self.path.split("/")[-2]
        if key not in ISSUES:
            self.send_json(404, {"errorMessages": ["Issue does not exist"]})
            return True
        ISSUES[key]["assignee"] = json.loads(raw).get("accountId")
        if ISSUES[key]["assignee"]:
            ISSUES[key]["notified"].append(ISSUES[key]["assignee"])
        self.send_response(204)
        self.end_headers()
        return True

    def browse(self, key):
        issue = ISSUES.get(key)
        if not issue:
            body = b"<h1>Issue not found</h1>"
        else:
            f = issue["fields"]
            atts = ""
            for a in issue["attachments"]:
                if a["type"] == "image/png":
                    atts += f'<p>{html.escape(a["filename"])}</p><img style="max-width:100%;border:1px solid #ccc" src="data:image/png;base64,{base64.b64encode(a["data"]).decode()}">'
                else:
                    atts += f'<p>{html.escape(a["filename"])} ({len(a["data"]):,} bytes)</p>'
            body = f"""<!doctype html><meta charset="utf-8"><title>{key}</title>
<body style="font:14px system-ui;max-width:900px;margin:30px auto">
<p style="color:#666">MOCK JIRA (testing only) · {key} · {html.escape(f['issuetype']['name'])} · labels: {html.escape(', '.join(f.get('labels', [])))}</p>
<p id="assignee">Assignee: {html.escape(USERS.get(issue['assignee'], {}).get('displayName', 'Unassigned'))} | notified: {html.escape(', '.join(USERS[a]['displayName'] for a in issue['notified']))}</p>
<h1>{html.escape(f['summary'])}</h1>
<h3>Description (wiki markup as sent)</h3><pre style="white-space:pre-wrap;background:#f4f5f7;padding:12px">{html.escape(f.get('description', ''))}</pre>
<h3>Comments ({len(issue.get('comments', []))})</h3>{''.join(f'<pre class="comment" style="white-space:pre-wrap;background:#eef;padding:12px">{html.escape(c)}</pre>' for c in issue.get('comments', []))}
<h3>Attachments ({len(issue['attachments'])})</h3>{atts}</body>""".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("Mock Jira (testing only) at http://localhost:8090  token: test-token  project: HACK")
    ThreadingHTTPServer(("", 8090), Handler).serve_forever()

# Development tools

## Demo page (`dev/demo`)
```bash
python3 dev/demo/server.py     # http://localhost:8080
```
Intentional bugs to try QA Buddy on:
- **Registration**: a name with an emoji or non-Latin letters → 404 on `/api/validate-name`, a console error and a crash
- **Preferences**: one failing request on page load (noise), then **Save preferences** calls the same broken endpoint three times
- **Find an attendee**: **Search** gives up after 4 s (cancelled), **Search (slow but works)** takes 6 s (slow), **Change filter** cancels after 0.5 s
- **Meeting agenda**: an iframe whose request times out after 4 s
- A fake analytics script from another domain fails to load (hidden as "other sites")

## Mock Jira (`dev/tools/mock-jira.py`), for testing only
```bash
python3 dev/tools/mock-jira.py  # http://localhost:8090
```
Settings in QA Buddy: Jira site `http://localhost:8090`, any email, token `test-token`.
- Projects: `HACK` (default assignee Project Lead, unassigned not allowed), `NOSCR` (no assignee field on the create screen)
- People: Test User (you), Project Lead, Omar Khaled
- Like real Jira: requests with browser cookies are rejected ("XSRF check failed"), attachments need `X-Atlassian-Token: no-check`
- View created issues at `http://localhost:8090/browse/HACK-1`

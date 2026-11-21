# QA Buddy: Chrome Web Store listing kit

Everything to paste into the Chrome Web Store Developer Dashboard for **QA Buddy**.
The privacy policy is `privacy-policy.html` at the root of this repository, published with GitHub Pages.

---

## 1. Store listing tab

**Name:** QA Buddy

**Summary** (max 132 characters):
> Capture bugs with errors, failed requests, steps, a replay and a screenshot, and report them to Jira in a few clicks.

**Description:**
> QA Buddy captures everything developers need to fix a bug, quietly in the background, and turns it into a complete Jira ticket.
>
> WHAT IT CAPTURES
> • Console errors, crashes and failed promises, with file, line and stack trace
> • Request problems: failed, cancelled and slow API calls, including inside iframes
> • Steps to reproduce: pages, clicks, selections and the fields you typed in (never what you typed)
> • A session replay of the moments before the bug (typed values masked)
> • A screenshot you can annotate and blur
> • Browser, operating system, screen and page details
>
> FOCUSED ON THE BUG
> • Shows only what happened after your last action, with older errors listed separately
> • Groups repeated calls to the same endpoint
> • Hides noise from other sites such as analytics and ads
> • Mark the main problem so developers know where to start
>
> REPORT TO JIRA
> • Create a new issue (choose project, issue type and assignee) or add the report to an existing ticket
> • Review exactly what will be sent before sending
> • Screenshot, full HTML report and replay are attached automatically
> • Or download the report, or copy it as text
>
> PRIVATE BY DESIGN
> • Data stays in your browser until you choose to send it to your own Jira
> • Passwords, tokens and typed values are masked
> • Choose which sites QA Buddy runs on
> • No analytics, no tracking, no servers of its own

**Category:** Developer Tools
**Language:** English

**Graphic assets** (in this kit):
- Store icon 128×128: `extension/icons/icon128.png`
- Screenshots 1280×800: `store/screenshots/1-capture.png`, `2-review.png`, `3-replay.png`, `4-privacy.png`
- Small promo tile 440×280: `store/promo-tile-440x280.png`

---

## 2. Privacy practices tab

**Single purpose:**
> QA Buddy helps people report website bugs: it captures technical details of errors on the current page (errors, failed requests, steps, a short replay and a screenshot) and lets the user review them and send them as an issue to their own Jira site.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `scripting` | Registers QA Buddy's capture scripts only on the sites the user allows in Settings, and reads page details (title, window size) and the session replay from the current tab when the user opens QA Buddy. |
| `storage` | Stores the user's settings (Jira site, email, API token, allowed sites) locally, and keeps captured bug data for the current tab in session storage until the report is sent or the tab is closed. |
| `webRequest` | Detects failed page resources (scripts, images, styles) on allowed sites so they can be included in the bug report. Requests are only observed, never blocked or modified. |
| Host permission `<all_urls>` | QA Buddy must capture errors on whichever website the user is testing (the user can limit this to specific sites in Settings), take a screenshot of the current tab, and send reports to the user's own Jira site, whose address varies per company. |

**Remote code:** No, I am not using remote code. All code, including the bundled rrweb library, is packaged in the extension.

**Data usage** (tick these):
- [x] **Personally identifiable information**: the user's Jira email in Settings; screenshots, replays and request data can contain names or emails shown on the page.
- [x] **Authentication information**: the user's Jira API token, stored locally and sent only to the user's Jira site.
- [x] **Web history**: steps include the pages opened in the tab, with titles and times.
- [x] **User activity**: clicks, navigation, network monitoring and mouse movement in the replay.
- [x] **Website content**: error messages, request addresses and response snippets, page text in the replay, screenshot.

Leave unticked: health, financial and payment, personal communications, location.

**Certifications** (tick all three):
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** the address where you host `privacy-policy.html` (step 4).

---

## 3. Distribution tab

- **Payments:** Free of charge
- **Visibility:** Public
- **Regions:** All regions

**Test instructions** (optional field for reviewers):
> QA Buddy works on any website. To try it: open any page, open the browser console and run `fetch('/does-not-exist')` and `console.error('test')`, then click the QA Buddy icon. The errors, steps and screenshot appear. "Download report" works without any account. Creating Jira issues requires the user's own Jira Cloud site and API token in Settings.

---

## 4. Submission steps

1. **Developer account**: sign in to the Chrome Web Store Developer Dashboard, accept the agreement, pay the one-time fee.
2. **Trader declaration**: choose what honestly describes you. For a free, personal, non-commercial project, that's usually **non-trader**. Read Google's explanation on that screen.
3. **Verification**: legal name, address, phone number, government ID and a document showing your name and current address. Use your real details.
4. **Privacy policy**: `https://ebrahemsamer2.github.io/qa-buddy/privacy-policy.html` (GitHub Pages, from this repository).
5. **Upload** the zip made by `scripts/package.sh` (Items → New item, or Package → Upload new package). `manifest.json` is at the top level of the zip.
6. Fill in the **Store listing**, **Privacy practices** and **Distribution** tabs from this kit.
7. **Submit for review.** Extensions with access to all sites get a closer review, so allow a few days.
8. **After approval:** add the store link to `README.md` and `index.html`.

## 5. Updates

1. Make the change and raise `version` in `extension/manifest.json` (for example 1.4.2 → 1.4.3).
2. Run `./scripts/package.sh` to build `dist/qa-buddy-<version>.zip`.
3. Dashboard → your item → **Package** → **Upload new package** → **Submit for review**.
4. Installed copies update automatically after approval, and users keep their settings.

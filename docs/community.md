# Repo, Distribution and Community

The goal is a repository that people arrive at, contribute to, and that survives its first author.
That is a design problem, not a marketing problem.

---

## 1. What exists in this repo today

```
manifest.json  versions.json  package.json  tsconfig.json  esbuild.config.mjs  vitest.config.ts
eslint.config.mjs  version-bump.mjs  LICENSE (MIT)  README.md
.github/workflows/{release,verify}.yml   .github/ISSUE_TEMPLATE/bug_report.yml   .github/FUNDING.yml
src/{main.ts,settings.ts,index,parse,schedule,channels,ui}
tests/{stubs,support.ts,17 suites}   scripts/smoke.mjs
docs/{PLAN,market,delivery,architecture,community,roadmap,risks,decisions}.md   docs/spec/*.md
```

## 2. Release pipeline

Mirrors the official template, which now includes supply-chain provenance:

1. `npm version patch` → `version-bump.mjs` rewrites `manifest.version` and adds
   `versions.json[version] = minAppVersion`.
2. Push the tag → `release.yml` checks out, installs Node 24, builds, attests `main.js` (+
   `styles.css`) with `actions/attest@v4`, and creates a **draft** release containing `main.js`,
   `manifest.json` and `styles.css`.
3. A human writes release notes (what changed, what to verify, known issues) and publishes.
4. `verify.yml` runs `tsc`, `eslint` (including `eslint-plugin-obsidianmd`) and `vitest` on every push
   and pull request. The real-app smoke test runs locally before every release — it needs a GUI, so it
   is a documented release step rather than a CI job.

Rules that are non-negotiable because the dashboard review enforces them on **every** version:

- The tag must equal `manifest.version`; the directory reads `manifest.json` at HEAD of the default
  branch.
- `versions.json` maps plugin version → minimum app version, so older apps get an older release.
- No global `app`, no `innerHTML`, no console noise, sentence-case UI text, no default hotkeys, all
  listeners registered through `registerEvent`/`registerInterval`/`addCommand`.
- No obfuscation, no client-side telemetry, no self-updating, and remote services must be disclosed in
  the README — which for this plugin means naming ntfy/Bark/Pushover/Telegram and stating exactly what
  leaves the device.

**Beta channel:** BRAT. Every release is installable from the repo via BRAT, and the README documents
it, so testers are never blocked on a directory update.

## 3. Governance that outlives the author

| Concern | Decision |
|---|---|
| Ownership | Move to an organisation (not a personal account) before v0.1 is submitted, so adding a maintainer does not require transferring a repo |
| Decision records | `docs/decisions.md` (ADRs) for engineering choices; `docs/spec/*` for the user-facing contracts, changed only through an RFC issue |
| RFC path | Any change to the syntax spec, the instance identity, or the state layout requires an issue with the `rfc` label, a 7-day comment window, and a note in `CHANGELOG.md` |
| Review ownership | `CODEOWNERS`: `docs/spec/**` and `src/schedule/**` need a second maintainer's review; channels and locales do not |
| Bus factor | Two committers with release rights by the end of Phase 2; credentials in a shared vault, documented in `MAINTAINING.md` |
| Support policy | Stated in the README: latest version only, vault-scoped reproduction required, no support for modified builds |
| Triage | Weekly pass; issues without a version/platform/reproduction get a template-based request and are closed after 30 days of silence |
| Scope discipline | The "not a task manager" list in `docs/PLAN.md` §4 is quoted when declining features, so scope creep is a policy decision rather than a mood |

The exemplars here are real: Tasks is org-owned with multiple committers and a contributor vault;
Day Planner survived a handover to a new maintainer and a community fork. Plugins die when they are a
single person's side project with no stated policy.

## 4. Contribution lanes (designed, not aspirational)

| Lane | Effort for a newcomer | Why it is attractive |
|---|---|---|
| **A channel** (LINE, Matrix, Home Assistant, DingTalk, WeCom, email, …) | One file implementing `DeliveryChannel`, one fixture test, one docs page | Immediately useful to their own setup; no engine knowledge needed |
| **A locale pack** | One data file + fixtures (`en` and `tr` ship as the worked examples) | A 20-line PR that unlocks a whole language; `chrono-node` cannot do this for these languages at all |
| **A recipe** | A markdown page in `docs/recipes/` | Journal workflows (shift work, medication, weekly review) that the maintainers would not think of |
| **A test-only PR** | Add a failing edge case | Explicitly welcomed; the Phase 0 defect list is public evidence that tests find real bugs |

Every lane has a labelled `good-first-issue` and a template. The channel and locale lanes are the
reason this plugin can grow coverage without the core team growing.

## 5. Funding and licensing

- **License:** MIT for the plugin (matching Tasks, Reminder and Remindian, which is what this
  ecosystem expects and what makes forking frictionless). Any future companion server gets a separate
  license (AGPL-3.0) so the hosted component cannot be silently closed while the client stays open.
- **Funding:** `fundingUrl` (GitHub Sponsors plus a one-off option) renders a Donate button in the
  plugin's settings; release notes carry the link once, not on every screen.
- **Labels:** the directory's `Free` label. No paid tier, no gated feature, no account — this is also
  the cheapest possible adoption story.
- **No sponsored placement** inside the plugin, and no dependency on a paid API in the default path.

## 6. Growth playbook

Ordered by measured effect for comparable plugins:

1. **The directory listing is the conversion surface.** Clean automated review, an accurate
   description, and screenshots. Most installs happen there and nowhere else.
2. **The README is the comparison page.** Users search "obsidian reminder vs tasks"; a table with
   only-shipped-behaviour rows wins those searches.
3. **Forum `Share & showcase`** and **Discord `#updates`/`#plugin-dev`** — the officially recommended
   announcement path.
4. **r/ObsidianMD showcase** with a short screen recording of the exact workflow in `docs/PLAN.md` §1
   (write tomorrow's line, get the alert), plus the words "local-first, no telemetry, no account".
5. **Newsletters and YouTube PKM channels** once there is a demo worth watching. Obsidian Roundup has
   ended; "This Week in Obsidian" and the PKM YouTube channels are the current reach.
6. **obsidianstats.com** as a passive discovery surface once the install curve starts.
7. **Reliability as content**: publishing the Phase 0 defect list and the two-device test protocol
   differentiates on engineering rather than on feature-count screenshots — and it is the exact
   dimension where the incumbents have open issues from 2022.

## 7. Support and privacy commitments, stated publicly

- No telemetry. Ever. Diagnostics are user-initiated and paste-able, with vault content excluded.
- The README names every remote service the plugin can talk to and what it sends.
- Tokens are plaintext in `data.json`; this is stated at the point of entry, not buried.
- Security reports: `SECURITY.md` with a private channel and a 72-hour acknowledgement target.

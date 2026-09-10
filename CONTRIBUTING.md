# Contributing to Kairos

Thanks for helping. This document tells you how to build the plugin, how to test it, and where the
useful contribution lanes are.

## Before you start

- Read `docs/PLAN.md` (what the plugin is for) and `docs/spec/syntax.md` plus `docs/spec/state-model.md`.
  Those two spec files are frozen contracts. A change to either needs an RFC issue first.
- Read `CONTEXT.md` for the vocabulary. It takes one minute and prevents most misunderstandings.
- Read `docs/PLAN.md` §4, "Non-goals". Kairos is not a task manager and not a calendar UI.

## Build and test

```bash
npm install
npm run build      # type check, then the production bundle (main.js)
npm test           # vitest run
npm run lint       # eslint, including eslint-plugin-obsidianmd
npm run smoke      # real Obsidian against .testvault, driven over CDP (needs macOS + Obsidian)
```

Requirements for a pull request:

1. `npm run build`, `npm test` and `npm run lint` pass. The lint gate tolerates zero warnings.
2. A change to parsing, scheduling or delivery also runs `npm run smoke`, and the pull request quotes
   its report.
3. New behaviour comes with a test that fails when the behaviour is removed. Tests that only assert a
   copy of an implementation detail are not accepted; see `docs/architecture.md` §7.
4. User-visible text is sentence case, and no string is added that the plugin cannot do.

## Contribution lanes

These lanes exist on purpose. They let the project grow without the core engine changing.

| Lane | What to write | Where |
|---|---|---|
| **A delivery channel** | One file that implements `DeliveryChannel` (`src/channels/types.ts`), one fixture test, one page in `docs/` | `src/channels/` |
| **A locale pack** | One data file for relative words, weekday and month names, and `am`/`pm` markers | `src/parse/locales/` |
| **A recipe** | A journal workflow other people can copy: shift work, medication, weekly review. Create the file in a new `docs/recipes/` folder | `docs/recipes/` |
| **A test-only pull request** | A failing edge case with the fix, or just the case | `tests/` |

Two locale packs ship as worked examples: `en` and `tr`.

## Reporting a bug

Use the bug report template. It asks for your plugin version, your platform, your Obsidian version,
and the steps to reproduce. Without a reproduction the issue cannot be fixed, because most defects in
this class of plugin depend on the note layout.

Run **Kairos: copy diagnostics** and paste the result. It contains no note content.

## Commits and pull requests

- One topic per pull request. Small is better.
- Write the commit subject in the imperative mood: "Fix digest gating", not "Fixed".
- If you change behaviour, say in the pull request body what a user will notice.
- Do not bump `manifest.json` or `versions.json` by hand. A maintainer does that at release time.

## Security

Do not open a public issue for a security problem. Follow `SECURITY.md`.

## Releasing (maintainers)

The tag must equal the `version` in `manifest.json`, and it must not have a `v` prefix. Obsidian reads
the manifest at the head of the default branch and then downloads the assets of the release whose tag
matches that version. A tag of `v0.1.0` would publish a release that no user ever receives.

1. `npm version patch` (or `minor`, or `major`). This rewrites `manifest.json`, adds the new entry to
   `versions.json`, and stages both files.
2. Commit the bump: `git commit -m "Release 0.1.0"`.
3. Tag it with the same version: `git tag 0.1.0`.
4. Push the branch and the tag: `git push origin main && git push origin 0.1.0`.
5. The `Release` workflow builds the plugin and opens a **draft** release containing `main.js`,
   `manifest.json` and `kairos.zip`. Add the release notes, then publish the draft.
6. Announce in the forum thread *Share & showcase* and in Discord `#updates`. The Discord channel
   needs the `developer` role.

`versions.json` maps a plugin version to the minimum app version. Add a mapping only when
`minAppVersion` changes; otherwise leave the file alone.

Do not re-tag a published version. If a release is wrong, publish the next patch version instead,
because users who already installed the first one will never see a change under the same version.

## Licence

By contributing you agree that your work is released under the MIT licence of this repository.

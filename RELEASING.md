# Releasing office-3d

A release is two things:

1. a versioned commit on `main` with a GitHub tag/release, and
2. a re-pinned entry in the official Hermes plugin catalog.

The catalog is the install channel (`hermes plugins install office-3d`), and it
pins an exact commit — a GitHub release alone does not reach catalog users.

Catalog entry:

- Official entry: <https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/office-3d.yaml>
- Staging fork used for catalog branches/PRs: <https://github.com/oslook/hermes-agent/blob/main/plugin-catalog/office-3d.yaml>
- Admission rules: <https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/README.md>
- Submission guide: <https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/catalog-submission>

## 1. Prepare the version

- Bump `version` in `plugin.yaml`.
- Add a `## [X.Y.Z] - YYYY-MM-DD` section at the top of `CHANGELOG.md`.
  Keep the catalog's `version` in step with it later.
- Update `platforms` and `requires_hermes` in `plugin.yaml` if the release
  changes them.
- Sync user-facing docs (`README.md`, `README.zh-CN.md`, `WINDOWS.md`) when
  behaviour, install steps or requirements changed.

## 2. Verify

Run everything from the repo root with a clean `main`.

Python suite — needs Hermes's own environment because the tests import
`hermes_constants`, `gateway.*` and FastAPI. On a standard install the
interpreter is `$HERMES_AGENT/venv/bin/python`; otherwise use whichever
interpreter can `import hermes_constants` and `import fastapi`:

```bash
HERMES_AGENT=${HERMES_AGENT:-$HOME/.hermes/hermes-agent}
PYTHONPATH="$HERMES_AGENT" "$HERMES_AGENT/venv/bin/python" \
  -m unittest discover -s tests -p 'test_*.py' -v
```

Desktop-half tests:

```bash
node --experimental-vm-modules tests/profile-visibility.mjs
node --experimental-vm-modules tests/route-query.mjs
```

Browser/layout harnesses (`tests/*-browser.mjs`, `tests/layout-preview.mjs`)
need a Playwright-capable environment; run them when the scene, layout, avatars
or wheels changed.

Catalog admission gate — the same check the catalog CI runs:

```bash
hermes plugins validate .
```

The run must end with `Validation passed.` Warnings are reported in the PR and
read by the reviewer; `dangerous` findings fail admission.

Then smoke the actual install path once, from a clean `HERMES_HOME` if possible:

```bash
hermes plugins install oslook/hermes-desktop-plugin-office-3d
hermes plugins enable office-3d
hermes plugins doctor office-3d
```

and reload the Desktop app / dashboard to confirm the page and `office_status`
still work.

## 3. Commit, tag, publish the GitHub release

```bash
VERSION=1.4.3   # example, no leading v

git add -A
git commit -m "chore: release v$VERSION"
git push origin main

git tag -a "v$VERSION" -m "Office 3D v$VERSION"
git push origin "v$VERSION"

# Release notes are the changelog section for this version.
awk -v h="## [$VERSION]" '
  index($0, h) == 1 { on = 1; next }
  /^## \[/ { on = 0 }
  on
' CHANGELOG.md > /tmp/office-3d-"$VERSION"-notes.md

gh release create "v$VERSION" \
  --title "Office 3D v$VERSION" \
  --notes-file /tmp/office-3d-"$VERSION"-notes.md \
  --latest
```

Conventions used by earlier releases: annotated tag message `Office 3D vX.Y.Z`,
release title `Office 3D vX.Y.Z`, stable (not prerelease), no uploaded assets.
The catalog installs the pinned commit, and catalog rule 3 forbids self-updating
code, so release artifacts are not part of the update path.

Check the `Validate plugin (catalog admission gate)` workflow on `main` is green.

## 4. Re-pin the catalog entry

Catalog rule 2: every entry pins a **full 40-character commit SHA**. Tags,
branches and short SHAs are rejected. Rule 4: every SHA bump is a **new PR** —
re-review of the old → new range is the update mechanism, so never push to an
already-merged entry branch.

Pin the commit that the tag points at:

```bash
SHA=$(git rev-parse "v$VERSION^{commit}")   # 40-hex SHA for the catalog
echo "$SHA"
git show "v$VERSION:plugin.yaml" | grep -E '^(version|platforms|requires_hermes):'
```

In `plugin-catalog/office-3d.yaml`, update every field that the release moved:

| Field | Source / rule |
|---|---|
| `sha` | tag commit, full 40-hex. The install checkout and README render use it. |
| `version` | `plugin.yaml` version, quoted. Cosmetic label on the card. |
| `platforms` | `plugin.yaml` platforms. Omit/empty means all platforms. |
| `requires_hermes` | Must match the floor in `plugin.yaml` (rule 14). |
| `image`, `screenshots` | `raw.githubusercontent.com/.../<owner>/<repo>/<new-sha>/docs/...`; pin to the new SHA. |
| `capabilities` | `provides_tools` / `provides_hooks` / `provides_middleware` / `requires_env` must match what loads at the pinned commit (rule 6). |
| `description` | Update when behaviour or disclosed reads/network calls change (rule 13). |

Then stage the PR from the fork (the same fork/branch flow used for the original
entry, upstream PR #142827):

```bash
git clone https://github.com/oslook/hermes-agent.git
cd hermes-agent
git fetch origin
git switch -c "catalog/office-3d-$VERSION" origin/main
$EDITOR plugin-catalog/office-3d.yaml

git add plugin-catalog/office-3d.yaml
git commit -m "plugin-catalog: bump office-3d to $VERSION (pin ${SHA:0:7})"
git push -u origin "catalog/office-3d-$VERSION"

gh pr create \
  --repo NousResearch/hermes-agent \
  --base main \
  --head "oslook:catalog/office-3d-$VERSION" \
  --title "plugin-catalog: bump office-3d to $VERSION (pin ${SHA:0:7})" \
  --body "Re-pin office-3d to v$VERSION. Diff: v<previous>...v$VERSION. Catalog checks: \`hermes plugins validate\` passed locally; CI gate covers admission."
```

The PR must contain **only** the catalog file. Rules that apply to the bump:
owner-or-major-contributor submission (rule 5), capability parity (rule 6),
desktop SDK-only surface (rule 8), no core overrides (rule 9), truthful
`requires_hermes` (rule 14). Reviewers re-read the upstream commit range.

## 5. Verify publication

After the catalog PR merges:

```bash
hermes plugins search office-3d
hermes plugins install office-3d
hermes plugins show office-3d        # version / pin shown on the card
hermes plugins update office-3d      # for machines already on the old pin
```

The docs page `https://hermes-agent.nousresearch.com/docs/plugins/office-3d`
renders the README at the newly pinned SHA, so a stale-looking page usually
means the catalog entry still points at the old commit.

## Release checklist

- [ ] `plugin.yaml` version bumped; `CHANGELOG.md` section added
- [ ] Python suite, desktop-half tests and `hermes plugins validate .` pass
- [ ] Fresh install + Desktop page + `office_status` smoke-tested
- [ ] Commit pushed to `main`; annotated tag `vX.Y.Z` pushed
- [ ] GitHub release published with changelog notes, not a prerelease
- [ ] Catalog entry re-pinned (`sha`, `version`, `platforms`,
      `requires_hermes`, image/screenshot URLs, capabilities)
- [ ] One-file catalog PR opened against `NousResearch/hermes-agent`
- [ ] Catalog workflow/validation green and entry merged
- [ ] `hermes plugins update office-3d` reaches the new pin

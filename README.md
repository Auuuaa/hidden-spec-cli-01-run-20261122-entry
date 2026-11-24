# hidden-spec-cli-01-run-20261122-entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Auuuaa/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Auuuaa/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies an AI-written edit to a tree of text files in four formats: unified diffs (with wrong line numbers tolerated), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls. Old lines are matched at the first of three tiers (exact, trailing whitespace ignored, surrounding whitespace ignored), and every edit applies or none does: a failed edit changes nothing, the edits after it still run, and the whole patch writes only when nothing failed.

## Run it

```sh
node main.ts fix.patch
```

`node main.ts` reads the patch from standard input when no patch file is given. `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`, `json`, or `auto`, the default, which detects it). `--check` reports what would change without writing anything. `--strict` matches lines exactly. See SPEC.md for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=j8zsssgk&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

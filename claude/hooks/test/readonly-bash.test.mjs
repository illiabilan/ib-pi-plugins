import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkCommand } from "../readonly-bash.mjs";

const HOOK = fileURLToPath(new URL("../readonly-bash.mjs", import.meta.url));
const S = "node ~/.claude/skills";

const ALLOWED = [
  "git status",
  "git -C /repo log --oneline -20 --author=alice",
  "git diff main...HEAD --stat",
  "git show abc123 -- src/a.ts",
  "git blame -L 10,20 src/a.ts",
  "git branch -a",
  "git stash list",
  "git tag --list 'v*'",
  "git config --get remote.origin.url",
  "git remote -v",
  "git diff | grep -n TODO | head -20",
  "rg -n 'foo' src 2>/dev/null",
  "npm test 2>&1 | tail -50",
  "npm ci",
  "npm install",
  "./gradlew :app:testDebugUnitTest --tests '*Foo*' > /tmp/test.log 2>&1",
  "pytest -q > $TMPDIR/out.txt",
  "pip install -r requirements.txt",
  "eslint src --format compact",
  "wc -l < src/a.ts",
  "gh pr checks 123",
  "gh run view 456 --log-failed | tail -n 200",
  "gh api repos/o/r/pulls/1",
  "gh api -X GET repos/o/r/issues",
  `${S}/slack/script/slack.mjs search 'in:#backend deploy'`,
  `${S}/slack/script/slack.mjs post '#general' hi --dry-run`,
  `${S}/jira/script/jira.mjs show ABC-123`,
  `${S}/jira/script/jira.mjs api GET /rest/api/2/myself`,
  `${S}/datadog/script/datadog.mjs logs 'service:api status:error' --from -15m`,
  `${S}/datadog/script/datadog.mjs monitor 123`,
  `${S}/android-vqa/script/android-vqa.mjs run --scenario s.json`,
  "echo 'rm -rf / > x' | cat",
  "cat <<'EOF'\nrm -rf src\ngit push --force\nEOF",
  "find . -name '*.kt' -type f | xargs grep -l Foo",
  "echo \"$(git rev-parse HEAD)\"",
];

const BLOCKED = [
  "rm -rf build",
  "mv a.ts b.ts",
  "sed -i '' 's/a/b/' src/a.ts",
  "sed -i.bak 's/a/b/' x",
  "perl -pi -e 's/a/b/' x",
  "echo hi > src/a.ts",
  "echo hi >> README.md",
  "cat x | tee src/out.ts",
  "git commit -m wip",
  "git push origin HEAD",
  "git -C /repo reset --hard",
  "git checkout -- src/a.ts",
  "git stash",
  "git add .",
  "git fetch origin",
  "git branch -D old",
  "git tag v1.0",
  "git config user.name x",
  "git status && git commit -am x",
  "git log; rm -rf /tmp2",
  "bash -c 'git push'",
  "sh -c \"echo x > file.txt\"",
  "eval 'rm x'",
  "echo $(rm -rf src)",
  "echo `git push`",
  "find . -name '*.orig' -delete",
  "find . -name '*.orig' -exec rm {} \;",
  "ls | xargs rm",
  "xargs -I{} mv {} /tmp < list",
  "sudo rm x",
  "FOO=1 git commit -m x",
  "gh pr create --title t --body b",
  "gh pr merge 12 --squash",
  "gh pr comment 12 --body hi",
  "gh run rerun 456",
  "gh api -X POST repos/o/r/issues -f title=x",
  "gh api repos/o/r/issues -f title=x",
  `${S}/slack/script/slack.mjs post '#general' hi`,
  `${S}/slack/script/slack.mjs reply https://x.slack.com/archives/C1/p1 ok`,
  `${S}/jira/script/jira.mjs transition ABC-1 --to Done`,
  `${S}/jira/script/jira.mjs comment ABC-1 --body x`,
  `${S}/jira/script/jira.mjs api POST /rest/api/2/issue`,
  `${S}/datadog/script/datadog.mjs monitor mute 123`,
  `${S}/datadog/script/datadog.mjs event post deploy`,
  `${S}/trello/script/trello.mjs card move abc --list Done`,
  "npm install lodash",
  "yarn add react",
  "pip install requests",
  "eslint src --fix",
  "prettier --write .",
  "gofmt -w .",
  "touch x",
  "cat <<EOF > src/gen.ts\nexport {}\nEOF",
];

for (const c of ALLOWED) test(`allows: ${c.replace(/\n/g, "\\n")}`, () => assert.deepEqual(checkCommand(c), []));
for (const c of BLOCKED) test(`blocks: ${c.replace(/\n/g, "\\n")}`, () => assert.ok(checkCommand(c).length > 0));

const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8" });

test("hook exits 2 with a reason on stderr for a blocked Bash call", () => {
  const r = run({ tool_name: "Bash", tool_input: { command: "git push" }, agent_type: "reviewer" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /read-only guard: `git push`/);
  assert.match(r.stderr, /The reviewer agent is read-only/);
});

test("hook exits 0 for an allowed call, other tools and bad input", () => {
  assert.equal(run({ tool_name: "Bash", tool_input: { command: "git log -5" } }).status, 0);
  assert.equal(run({ tool_name: "Read", tool_input: { file_path: "/x" } }).status, 0);
  const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
});

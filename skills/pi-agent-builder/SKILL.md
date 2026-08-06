---
name: pi-agent-builder
description: Designs and validates new Pi subagent definitions (agents/*.md used by the subagent extension) such as a code-writing agent, a reviewer, a planner, or any other specialized delegated agent. Encodes what makes an agent definition actually reliable to delegate to - correct frontmatter, tool restriction, model choice, a parseable output format, and behavioral testing (not just "it ran"). Use when asked to build/create/design a new subagent or specialized agent role. Always finish by invoking the agentic-tool-validation-loop skill, adapted per this skill's Phase 2 guidance, before declaring the work done.
---

# Pi Agent Builder

A playbook for building Pi subagent definitions (`agents/*.md`, discovered and
run by the `subagent` extension) that are actually reliable to delegate to -
not just definitions that parse and produce plausible-looking output once.

**This skill covers designing and hardening one agent definition. It assumes
the `subagent` extension itself is already installed (see
`extensions/subagent` in this repo, or the pi example of the same name). If
it isn't installed yet, that's a `pi-extension-builder` task first.**

**Relationship to `pi-extension-builder`:** that skill is for building tools/
commands/extensions the *main* agent calls inline. This skill is for
building a *specialized delegated agent* - an isolated `pi` subprocess with
its own system prompt, own tool restriction, own model - invoked via the
`subagent` tool. Same rigor, different artifact shape.

## 0. Clarify the agent's job before writing anything

A vague agent ("code_writer - writes code") is worse than no agent, because
the calling model will delegate to it based on its `description` and then be
surprised by what it actually does. Nail down, explicitly, before writing
frontmatter:

- **One job, stated narrowly.** "Implements a specific, already-scoped change
  to existing code" is a real job. "Writes code" is not - it collides with
  what the main agent already does by default. If the agent's job isn't
  meaningfully different from the main agent's default behavior, you may not
  need a subagent at all; you may need a prompt template or nothing.
- **What it must NOT do.** A reviewer must not modify files. A planner must
  not write code. A scout must not make judgment calls, only report findings.
  State the boundary explicitly - both in `tools` (frontmatter) and in the
  system prompt body (defense in depth; see docs' own words: "assume tool
  permissions are not perfectly enforceable").
- **What it hands off, and to whom.** Is this a leaf agent (produces a final
  answer) or a pipeline stage (its output feeds another agent/prompt
  template)? This decides how strict the output format needs to be.

## 1. Frontmatter

```markdown
---
name: code_writer
description: Implements a specific, already-scoped code change (new function,
  bugfix, refactor) given clear instructions or a plan. Does not investigate
  requirements or make architectural decisions - expects those already
  decided. Use when a change is well-specified and just needs implementing.
model: claude-sonnet-4-5
tools: read, grep, find, ls, edit, write, bash
---
```

- **`name`**: lowercase-hyphen-or-underscore, matches how it'll be invoked
  (`Use the subagent tool with agent: "code_writer"`).
- **`description`**: this is what the *calling* model uses to decide whether
  and when to delegate here - write it the same way you'd write a tool's
  `description` (per `pi-extension-builder` §8): specific, includes what it
  does AND does not do, not a vague feature list. This is the single biggest
  lever over whether the agent gets used correctly.
- **`model`**: match capability to task complexity and cost, don't default
  everything to the biggest model:
  - Narrow, mechanical, high-volume tasks (recon/lookup like `scout`) → a
    fast/cheap model (e.g. a haiku-class model).
  - Tasks requiring real judgment, code generation, or multi-step reasoning
    (implementation, planning, review) → a capable model (e.g. a
    sonnet-class model). Verify this choice empirically in Phase 2 rather
    than assuming - see below.
- **`tools`**: restrict to exactly what the job needs. Omit entirely only for
  a genuinely general-purpose agent (mirrors `worker` in the example set).
  A read-only agent (reviewer, planner, scout used for recon-only) should
  have no `write`/`edit` in its list - and this must be paired with an
  explicit instruction in the body per the point above, since the docs
  explicitly warn tool restriction isn't airtight.

## 2. System prompt body structure

Every reliable agent definition in practice has these sections, in this
order. Skipping the last two is the most common way an agent becomes
unreliable to chain or to trust:

1. **Role statement** - one or two sentences, matches `description`.
2. **Operating constraints** - "isolated context window," "work
   autonomously, don't ask for clarification unless truly blocked," and any
   hard boundary from step 0 stated as an instruction, not just a tools
   restriction (e.g. "Bash is for read-only commands only... do NOT modify
   files").
3. **Strategy** - a short numbered approach for how it should tackle the
   task. This measurably improves consistency across varied task phrasings;
   don't skip it even for an agent whose job seems obvious.
4. **Output format** - a literal Markdown template with named sections. This
   is not cosmetic: it's what makes the agent's result parseable by whatever
   called it (another agent in a chain, a prompt template, a human skimming
   a report). Include a "what to include if handing off to another agent"
   note when the agent is a pipeline stage, naming exactly what the next
   stage will need (file paths, key symbol names, assumptions made) - not
   prose that requires re-reading the whole output to extract.

## 3. Composability

If this agent is meant to be chained (e.g. `scout -> planner -> code_writer`,
mirroring the `implement` workflow prompt in the `subagent` example), design
its input/output contract explicitly:

- What does it expect to receive from the previous stage? State the expected
  input shape in the system prompt ("Input format you'll receive: ...").
- What must it emit for the next stage to consume without re-deriving
  context (exact file paths touched, exact function/type names, not just "I
  changed some files")?
- Consider adding a prompt template (`prompts/<workflow>.md`) that wires the
  new agent into a named workflow, the same way `/implement` wires
  `scout -> planner -> worker`.

## 4. Security posture

- Default `agentScope` only loads user-level agents
  (`~/.pi/agent/agents`) - project-local agents (`.pi/agents/*.md`) require
  an explicit `agentScope: "both"`/`"project"` and are only trustworthy in
  repos you trust, since they're repo-controlled prompts that can instruct
  arbitrary tool use.
- If the new agent has `write`/`edit`/unrestricted `bash`, treat it with the
  same caution as giving a new contributor commit access - test its
  boundaries adversarially (Phase 2) before trusting it in a real repo.

## 5. Mandatory final phase: empirical validation (adapted for agents)

Load `agentic-tool-validation-loop` and apply it - but the claims worth
testing for an *agent* are usually behavioral/correctness claims more than
pure token-cost claims:

1. **State the claim.** E.g.: "code_writer correctly implements a scoped
   change without exceeding its job (no unrequested refactors), and its
   report is complete enough that a reviewer agent could act on it without
   re-reading the diff."
2. **Run it for real** via the `subagent` tool (or a direct
   `pi -e ...` / configured agent invocation) on at least one representative
   task. Don't evaluate from reading the `.md` file - run it.
3. **Read the raw transcript**, not just the final report: did it call the
   tools you expect, in the order you expect? Did a "read-only" agent's
   transcript actually contain zero write/edit calls? Did it stay in scope?
4. **Adversarial cases specific to agents** (in addition to the general list
   in `agentic-tool-validation-loop`):
   - **Boundary-testing**: give a read-only/narrow-scope agent a task that
     invites it to exceed its boundary (a reviewer asked to "fix the bugs
     you find," a planner asked to "just implement it quickly") - does it
     correctly refuse/redirect, or does it comply and violate its stated
     job? This is the agent equivalent of the tool precision tests in the
     validation-loop skill - verify the restriction is real, don't just
     trust the frontmatter.
   - **Output format stability**: run 2-3 differently-phrased tasks of the
     same kind and confirm the output sections stay structurally
     consistent enough for a chain/parser to rely on.
   - **Model/cost fit**: compare the chosen model against a cheaper one on
     the same task (same technique as `run-pair.sh`, just swapping
     `--model` instead of `--exclude-tools`) - is the expensive model
     actually earning its cost for this specific job, or would a cheaper
     model do equally well?
   - **Delegation correctness**: from the *calling* agent's side, confirm it
     picks this new agent (over doing the task inline, or over a different
     existing agent) appropriately based on the `description` alone, without
     being told explicitly which agent to use.
5. **Fix and re-run** exactly as in the base methodology - a prompt tweak to
   the system prompt or `description` counts as a real fix; re-run the exact
   scenario that failed before considering it fixed.
6. **Report honestly**: what was proven (with the specific test task and
   transcript evidence), what was fixed, what boundary/edge cases remain
   untested.

An agent definition that "sounds right" and produced one plausible-looking
report is not validated. An agent definition whose boundaries were
deliberately tested and whose output was confirmed structurally reliable
across multiple phrasings is.

## 6. Two failure modes discovered by actually doing this (not hypothetical)

**A single passing trial does not prove a behavioral/boundary claim.** LLM
output is probabilistic. A boundary test run once and marked "correctly
refused" can behave completely differently on a re-run with near-identical
phrasing - including making exactly the unrequested architectural decisions
it was supposed to refuse. Concretely: an agent's own validation run judged
it "correctly refused to make architectural decisions" on a vague request;
a fresh, independent re-run of an almost identically-worded request instead
produced a full unsolicited implementation (a custom exception hierarchy, a
specific and debatable decision to reject booleans as input, always-float
return types) with no refusal at all. Same agent, same kind of prompt,
opposite behavior. Treat any boundary/refusal claim as requiring a **success
rate across multiple trials** (e.g. "refused inappropriately-scoped
requests in 4/5 trials"), not a binary pass/fail from one run - and say so
explicitly in the report rather than implying certainty from N=1.

**Self-validation by the same agent lineage that built the artifact is a
weaker signal than independent verification.** The agent (or the
agent-building agent) validating its own work is prone to running an easier
or more leading test than an independent evaluator would, and to
interpreting ambiguous output charitably. Wherever practical, the actual
verification step - not just the design - should be re-run independently
(a fresh session, a different phrasing not chosen by the builder, or a
human skeptically re-checking the specific claim) before a behavioral claim
is trusted, the same way `agentic-tool-validation-loop` distrusts a tool's
own self-reported success. A validation report produced by the same run
that built the thing is a first data point, not proof.

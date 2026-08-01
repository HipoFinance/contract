export const meta = {
  name: 'orchestrate',
  description: 'Plan a task with deep-reasoner, route each step to fast-worker or deep-reasoner, then verify',
  whenToUse: 'Multi-step tasks worth decomposing. Pass the task description as args (a string).',
  phases: [
    { title: 'Plan', detail: 'deep-reasoner decomposes the task into routed steps', model: 'opus' },
    { title: 'Execute', detail: 'each step runs on fast-worker (mechanical) or deep-reasoner (reasoning)' },
    { title: 'Verify', detail: 'deep-reasoner reviews the combined result', model: 'opus' },
  ],
}

const task = typeof args === 'string' ? args : args && args.task
if (!task) throw new Error('Pass the task description as args, e.g. Workflow({name: "orchestrate", args: "<task>"})')

const PLAN_SCHEMA = {
  type: 'object',
  required: ['steps'],
  properties: {
    analysis: { type: 'string', description: 'One-paragraph assessment of the task' },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        required: ['title', 'prompt', 'kind'],
        properties: {
          title: { type: 'string', description: 'Short step label' },
          prompt: {
            type: 'string',
            description: 'Self-contained instructions for the agent running this step: files, expected outcome, how to verify',
          },
          kind: {
            enum: ['mechanical', 'reasoning'],
            description: 'mechanical = well-specified edits/boilerplate/tests (fast-worker); reasoning = design, debugging, analysis (deep-reasoner)',
          },
        },
      },
    },
  },
}

phase('Plan')
const plan = await agent(
  `You are planning work in the Hipo contracts repo (read CLAUDE.md and docs/architecture.md as needed).

Decompose the following task into the minimal ordered sequence of steps. Steps run sequentially by separate agents that do not share your context, so each step's prompt must be self-contained (name the files, the expected outcome, and how to verify). Mark each step "mechanical" (well-specified edits, boilerplate, tests, formatting) or "reasoning" (design decisions, debugging, tricky analysis). Do NOT implement anything yourself — only plan.

Task:
${task}`,
  { agentType: 'deep-reasoner', label: 'plan', schema: PLAN_SCHEMA },
)
if (!plan) throw new Error('Planning step was skipped or failed')
log(`Plan: ${plan.steps.length} step(s) — ${plan.steps.map((s) => s.title).join(' → ')}`)

phase('Execute')
const results = []
for (let i = 0; i < plan.steps.length; i++) {
  const step = plan.steps[i]
  const agentType = step.kind === 'mechanical' ? 'fast-worker' : 'deep-reasoner'
  const context = results.length
    ? `\n\nReports from the steps already completed:\n${results
        .map((r, j) => `${j + 1}. ${plan.steps[j].title}: ${r.report}`)
        .join('\n')}`
    : ''
  const report = await agent(
    `You are executing step ${i + 1} of ${plan.steps.length} of a larger task: "${task}"

Your step: ${step.title}

${step.prompt}${context}`,
    { agentType, label: `${i + 1}/${plan.steps.length} ${step.title}`, phase: 'Execute' },
  )
  results.push({ step: step.title, kind: step.kind, report: report ?? '(skipped or failed)' })
  log(`Step ${i + 1}/${plan.steps.length} done: ${step.title}`)
}

phase('Verify')
const review = await agent(
  `A multi-step task was just executed in this repo. Review whether it is actually complete and correct.

Task: ${task}

Step reports:
${results.map((r, i) => `${i + 1}. ${r.step} (${r.kind}): ${r.report}`).join('\n\n')}

Check the working tree for what actually changed, run the cheapest relevant verification (lint, a targeted test file — not the full slow suite), and report: whether the task is complete, any gaps or defects found, and concrete follow-ups if needed.`,
  { agentType: 'deep-reasoner', label: 'verify' },
)

return { analysis: plan.analysis, steps: results, review }

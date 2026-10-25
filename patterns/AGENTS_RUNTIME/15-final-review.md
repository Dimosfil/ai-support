## Task Completion Review Preference

- Treat `gi проверка`, `ги проверка`, `gi verification`, and `gi check` as
  commands to configure the final task-result review, not to run project tests.
- Store the project setting in
  `tools/project-memory/verification-preferences.json` as
  `task_completion_review.enabled` (a JSON boolean). Default to `true` when
  the file or setting is absent. Preserve unrelated fields and existing choices
  during setup, updates, and language changes. Report invalid JSON or a non-boolean
  setting; do not silently overwrite it or claim a known selection.
- Without an explicit choice, show the current setting followed by three plain
  numbered inline checkbox lines, using the user's working language:
  `[x] 1. Вкл`, `[ ] 2. Выкл`, `[ ] 3. Отмена` (each on its own physical line).
  Check only the current On/Off option. Do not use Markdown task-list syntax.
  Accept one number against the latest checklist, or `вкл`/`on`, `выкл`/`off`,
  `отмена`/`cancel`. Cancellation makes no file changes. Ambiguous or invalid
  replies keep the flow pending without writes. An explicit command such as
  `ги проверка выкл` saves that choice directly without another question.
- Use `tools/select-task-verification.ps1 -Selection <choice>` to save the
  selection when installed; in this source library use
  `templates/select-task-verification.template.ps1`. Show the checklist in chat
  and collect a reply before invoking the helper; do not start a blocking terminal
  prompt for an unanswered chat choice. Read back the saved boolean and briefly
  confirm the result. This command does not run the review or a test suite.

## Final Task-Result Review

- When enabled, perform this additional review only after task execution and
  required checks finish, immediately before the final completion response.
  Do not add this pass or its checkmarks to intermediate progress, clarification,
  or preference-selection messages. A blocked/unfinished task must remain
  explicitly unfinished; a partial-result handoff may verify only its delivered
  part and must identify the remaining blocker.
- Review the actual result and material factual claims intended for the final
  response. Follow the referenced links and inspect the linked content; a
  reachable page alone does not establish that it supports the claim. Verify
  local paths and claimed changes against current files/diffs, and execution
  claims against actual command or test results. Reuse current, directly relevant
  evidence from this task; do not rerun unchanged sufficient checks merely to
  add a checkmark. For external sources, use permitted read tools within existing
  access and scope; do not follow links into writes, logins, purchases, or other
  side effects.
- Correct unsupported or contradicted claims before sending. Mark confirmed
  material claims/results with `✓` and a concise source or verification reference
  where useful. Keep the final response compact; do not expose a lengthy audit
  trail or mark proposals, assumptions, or unperformed actions as confirmed.
- If a fact, link, or result cannot be confirmed, say exactly what remains
  unverified and why (for example, unavailable source, access limit, or a check
  that could not run). Never imply verification succeeded because a link exists
  or a check was planned. Preserve honest uncertainty and scoped blockers even
  when this preference is off.
- Disabling this preference disables only this additional final-answer review
  and its checkmark presentation. It does not disable required project checks,
  factual accuracy, source requirements, safety rules, or explicit user requests
  to verify a result.

## Document-Based Conclusions

- Apply this document-specific pass under the same task-completion preference,
  after the document task is executed and before the final response. For an
  analysis, review, summary, or document drafted from sources, reread the source
  document and the delivered text; revisit ambiguous, disputed, or contradictory
  passages in their surrounding context, including definitions and exceptions.
- Question each disputed interpretation: does the document actually say this,
  what assumptions connect the passage to the conclusion, and could another
  passage or reasonable reading change it? Resolve what the source supports;
  distinguish the document's wording from the agent's inference. Do not turn
  these self-check questions into an unnecessary user clarification gate.
- For every conclusion drawn from a source document, show its basis next to it:
  identify the document/version when relevant, the numbered point or page/section,
  and a short verbatim quotation supporting that conclusion. If the source has
  no numbering, use an existing heading, paragraph location, or opening words;
  never invent a point number. A bibliography or link alone does not replace
  this conclusion-to-passage mapping. Put the mapping in the delivered analysis
  or document when that is the task output; a chat-only assurance is insufficient.
- Copy quotations exactly from inspected source text, preserving qualifications
  and negations. Identify omissions and separate passages transparently; do not
  present a paraphrase or translation as the original verbatim quotation. Check
  uncertain OCR/extraction against the original where accessible; otherwise flag
  the quotation as unverified. Respect applicable quotation limits and access
  rules; if an exact supporting quote cannot be supplied, state that limitation.
- Correct or remove unsupported conclusions, or label them explicitly as
  assumptions/open interpretations with the missing evidence. When passages
  conflict, identify both rather than silently choosing one. Mark a conclusion
  `✓` only when the inspected passage and context support it; an accurate quote
  alone does not prove an inference. Do not invent missing text or certainty.

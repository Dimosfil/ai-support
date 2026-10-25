# Task Completion Review Contract

## Behavior

Deliver the runtime module, selector, preserved preference, command route and
entrypoint as one component. A version checkpoint alone does not prove delivery.
Forward migration `2026.10.25.4__repair_task_review_delivery` restores this
component for projects that skipped the late-published historical IDs.

`ги проверка`, `gi проверка`, `gi verification`, and `gi check` configure a
project-local preference. They do not run the tester. With no explicit choice,
show current state and plain numbered checkbox lines for On, Off, Cancel.
Accept one number/name against that checklist; invalid input waits without a
write, and cancellation preserves the original file. An explicit choice saves
directly. Read back the boolean before confirming it.

Store `task_completion_review.enabled` in
`tools/project-memory/verification-preferences.json`; a missing setting means
enabled. Reject malformed state without overwriting it. Preserve unrelated
fields and keep the file separate from language preferences. Bootstrap and
migrations preserve existing selections, including `false`.

When enabled, run the additional review after task execution and required checks,
before the final completion response. Check the delivered result, links, and
material factual claims; reuse sufficient current evidence. A link must support
the claim, not merely respond successfully. Mark verified results `✓` and
identify unconfirmed items with the reason. Do not add the pass to progress,
clarification, or selection messages. Partial work stays explicitly partial.
Off disables only this extra review/presentation, never required project checks,
truthful reporting, or an explicit user verification request.

For document-based tasks, this same preference also controls a final reread of
the source and delivered text. Revisit disputed passages with their context,
definitions, and exceptions; test alternate interpretations without requiring
the user to answer the agent's self-check questions. Map every source-derived
conclusion in the delivered analysis/document to a point/page/section and a short
verbatim supporting quotation. Distinguish quoted text from inference, preserve
negations and qualifications, and identify both sides of conflicting evidence.
Missing numbering, unavailable text, uncertain OCR, quotation limits, or
unsupported reasoning must lead to a precise limitation, not invented anchors,
quotes, or confirmation. This adds no separate preference or mid-task pass.

## Mechanism And Ownership

Scenario -> chat route `task-verification` in `config/gi-command-routes.json`
-> `15-final-review.md` owns selection/review semantics -> selector
template owns validated persistence -> entrypoints load the module before final responses ->
context builder surfaces current state -> installer delivers helper/default
without replacing existing project state.

The source repository uses the template helper directly; consuming projects use
`tools/select-task-verification.ps1`. No new service or UI framework is required.

## Verification

`tools/test-task-verification.ps1` covers On/Off, numeric and named input,
cancellation, invalid input/state, preservation of unrelated settings, installed
helper delivery and state through the public context builder. Forward-repair
cases reproduce both affected checkpoints, restore delivery,
preserve existing Off/custom fields, load all aliases and Work/Complete, then
record only the verified repair. Existing
`tools/test-gi-context-routing.ps1` checks aliases and context budgets;
`tools/test-instruction-kit-bootstrap.ps1` checks delivery for supported source
forms. Instruction review covers final-only timing, evidence quality, and honest
unverified outcomes; automated tests cannot prove a future agent follows prose.
Document review cases: supported conclusion with exact point/quote; ambiguous
passage with exception; conflicting passages; unnumbered document; unavailable
source or uncertain OCR; inference not established by a literal quotation.

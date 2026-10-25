import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// OpenCode 1.x adapter. Policy, fingerprints, receipts and retry limits belong
// to invoke-gi-lifecycle-hook.ps1, shared with the Codex adapter.
export default async function GiLifecycle({ client, directory }) {
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const cwd = await realpath(directory);
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('GI plugin directory does not belong to its installed project.');
  }
  if (typeof client?.session?.prompt !== 'function') {
    throw new Error('GI requires the OpenCode 1.x session.prompt API with noReply support.');
  }
  const sessions = new Map();
  const failure = () => new Error('GI mandatory context or completion verification failed; task remains unverified.');

  function stateFor(sessionID) {
    if (!sessionID) throw failure();
    if (!sessions.has(sessionID)) sessions.set(sessionID, { turn: '', continued: false });
    return sessions.get(sessionID);
  }

  async function invoke(sessionID, hook_event_name, extra = {}) {
    const state = stateFor(sessionID);
    const event = {
      host: 'opencode', cwd, session_id: sessionID, turn_id: state.turn,
      hook_event_name, ...extra,
    };
    const result = await new Promise((resolve, reject) => {
      const process = spawn(globalThis.process.env.GI_PWSH || 'pwsh', [
        '-NoProfile', '-NonInteractive', '-File', path.join(root, 'tools/invoke-gi-lifecycle-hook.ps1'),
      ], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let hasErrors = false;
      const timer = setTimeout(() => { process.kill(); reject(failure()); }, 30_000);
      process.on('error', () => { clearTimeout(timer); reject(failure()); });
      process.stdin.on('error', () => {});
      process.stdout.setEncoding('utf8');
      process.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 1_048_576) { process.kill(); reject(failure()); }
      });
      process.stderr.on('data', () => { hasErrors = true; });
      process.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || hasErrors) return reject(failure());
        try { resolve(JSON.parse(output)); } catch { reject(failure()); }
      });
      process.stdin.end(JSON.stringify(event));
    });
    if (result.continue === false) throw failure();
    return result;
  }

  async function context(sessionID, event) {
    const result = await invoke(sessionID, event);
    const text = result.hookSpecificOutput?.additionalContext;
    if (typeof text !== 'string' || !text.trim()) throw failure();
    return text;
  }

  return {
    'chat.message': async (input, output) => {
      const state = stateFor(input.sessionID);
      // Only our exact, in-flight synthetic review may reuse a receipt. Other
      // callers (including resumed task sessions) start an independent turn.
      if (state.injecting && output.parts.some((part) =>
        part.type === 'text' && part.synthetic === true && part.text === state.injecting)) return;
      if (output.message.format?.type === 'json_schema') {
        throw new Error('GI pre-completion review currently supports text responses, not structured output.');
      }
      sessions.set(input.sessionID, {
        turn: output.message.id, continued: false, agent: output.message.agent,
        model: output.message.model, variant: output.message.variant,
      });
    },
    'chat.params': async (input) => {
      const state = stateFor(input.sessionID);
      state.agent = input.agent;
      state.model = input.message.model;
      state.variant = input.message.variant;
    },
    'experimental.chat.system.transform': async (input, output) => {
      if (!input.sessionID) return; // Auxiliary requests without a task session.
      output.system.push(await context(input.sessionID, 'UserPromptSubmit'));
    },
    'experimental.session.compacting': async (input, output) => {
      output.context.push(await context(input.sessionID, 'SessionStart'));
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'task') return;
      const result = await invoke(input.sessionID, 'PreToolUse', {
        tool_name: input.tool, tool_input: output.args,
      });
      const forwarded = result.hookSpecificOutput;
      if (forwarded?.permissionDecision !== 'allow' || typeof forwarded.updatedInput?.prompt !== 'string') {
        throw failure();
      }
      // The shared engine changes only prompt; host permissions still apply.
      output.args = forwarded.updatedInput;
    },
    'experimental.text.complete': async (input) => {
      const message = await client.session.message({
        path: { id: input.sessionID, messageID: input.messageID }, throwOnError: true,
        signal: AbortSignal.timeout(30_000),
      });
      if (message.error || !message.data?.info) throw failure();
      if (message.data.info.summary) return; // Compaction has its own context hook.
      const state = stateFor(input.sessionID);
      if (state.handledMessage === input.messageID) return;
      const result = await invoke(input.sessionID, 'Stop', { stop_hook_active: state.continued });
      if (state !== sessions.get(input.sessionID)) return; // A newer user turn wins.
      state.handledMessage = input.messageID;
      if (result.decision !== 'block') return;
      if (typeof result.reason !== 'string' || !result.reason.trim()) throw failure();
      state.injecting = result.reason;
      try {
        // Persist a synthetic user message *before* the running loop checks its
        // exit condition. noReply avoids recursively waiting on that same loop.
        // This is intentionally not an idle-event restart or text replacement.
        const queued = await client.session.prompt({
          path: { id: input.sessionID },
          body: {
            noReply: true, agent: state.agent, model: state.model, variant: state.variant,
            parts: [{ type: 'text', text: result.reason, synthetic: true }],
          },
          throwOnError: true,
          signal: AbortSignal.timeout(30_000),
        });
        if (queued.error || !queued.data?.info?.id || queued.data.info.id <= input.messageID) throw failure();
        state.continued = true;
      } catch { throw failure(); }
      finally { delete state.injecting; }
    },
    event: async ({ event }) => {
      if (event.type === 'session.deleted') sessions.delete(event.properties.info.id);
      if (event.type === 'session.error') sessions.delete(event.properties.sessionID);
    },
  };
}

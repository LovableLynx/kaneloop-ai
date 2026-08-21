export type StepState = 'pending' | 'running' | 'pass' | 'fail'

export type StatusTracker = {
  plan: StepState
  generate: StepState
  verify: StepState
}

export type KaneEventResult = {
  log: string | null
  statusPatch: Partial<StatusTracker> | null
}

/**
 * Parses a single NDJSON line from `kane-cli run --agent` and maps it to a
 * log line + status patch. Kept separate from the file-replay / live-stream
 * transport so the same logic works for both.
 *
 * `isFinalStep` marks whether this line came from the last step of a
 * multi-step bridge run (see kane-bridge.mjs). Only the final step's
 * run_end sets the actual Verify pass/fail — earlier steps' run_end events
 * are intermediate checks (e.g. reading initial state), not the verdict.
 */
export function parseKaneLine(line: string, isFinalStep = true): KaneEventResult {
  const trimmed = line.trim()
  if (!trimmed) return { log: null, statusPatch: null }

  let event: Record<string, unknown>
  try {
    event = JSON.parse(trimmed)
  } catch {
    // Kane also prints plain-text banners (e.g. "Running on: Desktop · Chrome")
    // interleaved with NDJSON. Surface those as raw log lines.
    return { log: trimmed, statusPatch: null }
  }

  switch (event.type) {
    case 'recording_state':
      return { log: `session started: ${event.session_id}`, statusPatch: { plan: 'running' } }

    case 'bifurcation':
      return {
        log: `plan: ${(event.count as number) ?? 1} flow(s) identified`,
        statusPatch: { plan: 'pass', generate: 'running' },
      }

    case 'bridge_step_start':
      return { log: `— starting step ${(event.step_index as number) + 1} —`, statusPatch: null }

    case 'bridge_step_end':
      return {
        log: `— step ${(event.step_index as number) + 1} finished (exit ${event.exit_code}) —`,
        statusPatch: null,
      }

    case 'run_end': {
      const status = event.status === 'passed' ? 'pass' : 'fail'
      const summary = (event.summary as string) ?? (event.one_liner as string) ?? ''
      const label = isFinalStep ? 'verify' : 'check'
      return {
        log: `${label}: ${event.status} — ${summary.split('\n')[0]}`,
        // A failure keeps Verify in "running" rather than "fail" here — the
        // bridge may still be about to attempt an auto-heal + retry. Only
        // heal_end (out of attempts) or the ultimate passing run_end should
        // settle the badge.
        statusPatch:
          status === 'pass'
            ? { generate: 'pass', verify: isFinalStep ? 'pass' : 'running' }
            : { generate: 'pass', verify: 'running' },
      }
    }

    case 'heal_start':
      return {
        log: `heal attempt ${event.attempt}: asking Claude to fix src/App.tsx…`,
        statusPatch: { verify: 'running' },
      }

    case 'heal_end': {
      const ok = event.exit_code === 0
      return {
        log: `heal attempt ${event.attempt} ${ok ? 'applied a fix' : 'failed to apply a fix'}, re-running verify…`,
        statusPatch: null,
      }
    }

    case 'heal_error':
      return { log: `heal error: ${event.message}`, statusPatch: null }

    case 'heal_reverted_stray_edits':
      return {
        log: `heal attempt ${event.attempt} touched files outside src/App.tsx (${(event.files as string[]).join(', ')}) — reverted automatically`,
        statusPatch: null,
      }

    case 'heal_stderr':
      return { log: `heal stderr: ${event.message}`, statusPatch: null }

    case 'heal_exhausted':
      return {
        log: `verify: still failing after ${event.attempts} heal attempt(s) — giving up`,
        statusPatch: { verify: 'fail' },
      }

    case 'ask_user':
      // Kane needs input it can't get on its own (most commonly login
      // credentials for a real site). There's no interactive channel back
      // to Kane from this UI, so rather than let the run hang until Kane's
      // own internal timeout kills it, surface this clearly and fail fast.
      // Supplying credentials via the "Login" fields avoids this entirely.
      return {
        log: `verify: Kane needs input it didn't have — "${event.question}". Provide credentials in the Login fields, or make the objective self-contained.`,
        statusPatch: { verify: 'fail' },
      }

    default: {
      // Step progress events: {"step":N,"status":"running"|"done","remark":"..."}
      if (typeof event.step === 'number' && typeof event.status === 'string') {
        const remark = (event.remark as string) ?? ''
        return { log: `step ${event.step} ${event.status}: ${remark}`, statusPatch: null }
      }
      return { log: trimmed, statusPatch: null }
    }
  }
}

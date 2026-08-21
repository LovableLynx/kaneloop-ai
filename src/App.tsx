import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'
import { parseKaneLine, type StatusTracker } from './kaneEvents'

const INITIAL_STATUS: StatusTracker = {
  plan: 'pending',
  generate: 'pending',
  verify: 'pending',
}

const KANE_BRIDGE_URL = 'http://localhost:8787/run'

// Two independent objectives, run as two separate kane-cli processes in
// strict sequence by the bridge. This guarantees ordering that a single
// prose objective could not: the inner agent was observed clicking
// Increment before reading the "before" value even when told explicitly
// not to. Splitting the read and the click into separate processes means
// there is no click to reorder into step 1.
const DEFAULT_STEPS = [
  `Navigate to http://localhost:5173. Read the text of the element with data-testid=count-display. Assert it equals exactly 'Count: 0'. Do not click anything.`,
  `Navigate to http://localhost:5173. Click the element with data-testid=increment-btn. Then read the text of the element with data-testid=count-display. Assert it equals exactly 'Count: 1'.`,
]

const DEFAULT_TARGET_URL = 'http://localhost:5173'

function App() {
  const [prompt, setPrompt] = useState('')
  const [targetUrl, setTargetUrl] = useState('')
  const [status, setStatus] = useState<StatusTracker>(INITIAL_STATUS)
  const [logs, setLogs] = useState<string[]>([])
  const [bridgeUnreachable, setBridgeUnreachable] = useState(false)

  const appendLog = useCallback((line: string) => {
    setLogs((prev) => [...prev, line])
  }, [])

  const updateStatus = useCallback((patch: Partial<StatusTracker>) => {
    setStatus((prev) => ({ ...prev, ...patch }))
  }, [])

  const handleGenerate = useCallback(() => {
    setStatus(INITIAL_STATUS)
    setLogs([])
    setBridgeUnreachable(false)

    const rawUrl = targetUrl.trim() || DEFAULT_TARGET_URL
    let parsedUrl: URL
    try {
      parsedUrl = new URL(rawUrl)
    } catch {
      appendLog(`invalid target URL: "${rawUrl}"`)
      updateStatus({ plan: 'fail', generate: 'fail', verify: 'fail' })
      return
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      appendLog(`unsupported URL scheme: "${parsedUrl.protocol}" — only http/https allowed`)
      updateStatus({ plan: 'fail', generate: 'fail', verify: 'fail' })
      return
    }

    const steps = prompt.trim()
      ? [`Navigate to ${parsedUrl.toString()}. ${prompt.trim()}`]
      : DEFAULT_STEPS
    const lastStepIndex = steps.length - 1
    appendLog(`> generate: ${steps.length} step(s) queued against ${parsedUrl.origin}`)

    let currentStepIndex = 0

    const url = `${KANE_BRIDGE_URL}?steps=${encodeURIComponent(JSON.stringify(steps))}`
    const source = new EventSource(url)

    source.onmessage = (event) => {
      let stepIndexHint: number | null = null
      try {
        const parsed = JSON.parse(event.data)
        if (typeof parsed.step_index === 'number') stepIndexHint = parsed.step_index
      } catch {
        // not a bridge marker event, ignore
      }
      if (stepIndexHint !== null) currentStepIndex = stepIndexHint

      const { log, statusPatch } = parseKaneLine(event.data, currentStepIndex === lastStepIndex)
      if (log) appendLog(log)
      if (statusPatch) updateStatus(statusPatch)
    }

    source.addEventListener('close', () => {
      source.close()
    })

    source.onerror = () => {
      // EventSource auto-retries by default; on a hosted/static deploy the
      // bridge is never reachable, so without an explicit close+fail here
      // the UI would sit on "pending" forever and look broken rather than
      // "needs the local bridge server".
      appendLog(
        'kane-bridge unreachable — this deployed preview has no local kane-cli bridge. Run this project locally (see README) for the live Plan → Generate → Verify loop.',
      )
      updateStatus({ plan: 'fail', generate: 'fail', verify: 'fail' })
      setBridgeUnreachable(true)
      source.close()
    }
  }, [prompt, targetUrl, appendLog, updateStatus])

  return (
    <div className="playground">
      <header className="topbar">
        <h1 data-testid="app-title">Prompt-to-Feature Visual Playground</h1>
      </header>

      <div className="split">
        <LeftPanel
          prompt={prompt}
          onPromptChange={setPrompt}
          targetUrl={targetUrl}
          onTargetUrlChange={setTargetUrl}
          onGenerate={handleGenerate}
          status={status}
        />
        <RightPanel bridgeUnreachable={bridgeUnreachable} />
      </div>

      <LogConsole logs={logs} />
    </div>
  )
}

function LeftPanel({
  prompt,
  onPromptChange,
  targetUrl,
  onTargetUrlChange,
  onGenerate,
  status,
}: {
  prompt: string
  onPromptChange: (value: string) => void
  targetUrl: string
  onTargetUrlChange: (value: string) => void
  onGenerate: () => void
  status: StatusTracker
}) {
  return (
    <div className="pane left">
      <div className="pane-header">Target URL</div>
      <input
        className="url-input"
        data-testid="target-url-input"
        type="text"
        placeholder={DEFAULT_TARGET_URL}
        value={targetUrl}
        onChange={(e) => onTargetUrlChange(e.target.value)}
        spellCheck={false}
      />

      <div className="pane-header">Feature Request</div>
      <textarea
        className="prompt-input"
        data-testid="prompt-input"
        placeholder="Describe the feature you want…"
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        spellCheck={false}
      />
      <button
        className="generate-btn"
        data-testid="generate-btn"
        onClick={onGenerate}
      >
        Generate
      </button>

      <div className="pane-header">Status</div>
      <StatusStepper status={status} />
    </div>
  )
}

const STEP_LABELS: { key: keyof StatusTracker; label: string }[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'generate', label: 'Generate' },
  { key: 'verify', label: 'Verify' },
]

function StatusStepper({ status }: { status: StatusTracker }) {
  return (
    <div className="status-stepper" data-testid="status-stepper">
      {STEP_LABELS.map(({ key, label }) => (
        <div key={key} className="status-step" data-testid={`status-step-${key}`}>
          <span className={`status-dot status-dot-${status[key]}`} />
          <span className="status-label">{label}</span>
          <span
            className={`status-badge status-badge-${status[key]}`}
            data-testid={`status-badge-${key}`}
          >
            {status[key]}
          </span>
        </div>
      ))}
    </div>
  )
}

function RightPanel({ bridgeUnreachable }: { bridgeUnreachable: boolean }) {
  return (
    <div className="pane right">
      <div className="pane-header">Live Preview</div>
      {bridgeUnreachable && (
        <div className="bridge-note" data-testid="bridge-unreachable-note">
          This preview runs client-side only — Verify can't reach a local
          kane-cli bridge from this deployed site. Clone and run locally to
          see it actually verified.
        </div>
      )}
      <div className="sandbox-card" data-testid="sandbox-card">
        <div className="sandbox-card-label">GeneratedSandbox</div>
        <div className="sandbox-card-body" data-testid="sandbox-frame">
          <GeneratedSandbox />
        </div>
      </div>
    </div>
  )
}

function GeneratedSandbox() {
  const [count, setCount] = useState(0)
  const [name, setName] = useState('')
  const [darkMode, setDarkMode] = useState(false)
  const [email, setEmail] = useState('')
  const [todoInput, setTodoInput] = useState('')
  const [todos, setTodos] = useState<string[]>([])

  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

  const addTodo = () => {
    const trimmed = todoInput.trim()
    if (!trimmed) return
    setTodos((prev) => [...prev, trimmed])
    setTodoInput('')
  }

  return (
    <div
      className={`preview-app${darkMode ? ' preview-app-dark' : ''}`}
      data-testid="generated-sandbox"
    >
      {/* 1. Counter — click interaction */}
      <section className="feature-block">
        <p data-testid="count-display">Count: {count}</p>
        <button
          data-testid="increment-btn"
          onClick={() => setCount((c) => c + 1)}
        >
          Increment
        </button>
      </section>

      {/* 2. Name greeting — text input + read */}
      <section className="feature-block">
        <input
          data-testid="name-input"
          type="text"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p data-testid="greeting-display">
          {name.trim() ? `Hello, ${name.trim()}!` : 'Hello, stranger!'}
        </p>
      </section>

      {/* 3. Dark-mode toggle — visual/attribute state */}
      <section className="feature-block">
        <label>
          <input
            data-testid="dark-mode-toggle"
            type="checkbox"
            checked={darkMode}
            onChange={(e) => setDarkMode(e.target.checked)}
          />
          Dark mode
        </label>
        <span data-testid="dark-mode-status">
          {darkMode ? 'Dark mode: on' : 'Dark mode: off'}
        </span>
      </section>

      {/* 4. Email validation — conditional logic */}
      <section className="feature-block">
        <input
          data-testid="email-input"
          type="text"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p data-testid="email-validation-message">
          {email.length === 0
            ? ''
            : isValidEmail
              ? 'Valid email'
              : 'Invalid email'}
        </p>
      </section>

      {/* 5. Todo list — growing list state */}
      <section className="feature-block">
        <input
          data-testid="todo-input"
          type="text"
          placeholder="Add a todo"
          value={todoInput}
          onChange={(e) => setTodoInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTodo()
          }}
        />
        <button data-testid="todo-add-btn" onClick={addTodo}>
          Add
        </button>
        <ul data-testid="todo-list">
          {todos.map((todo, i) => (
            <li key={i} data-testid={`todo-item-${i}`}>
              {todo}
            </li>
          ))}
        </ul>
        <span data-testid="todo-count">{todos.length} item(s)</span>
      </section>
    </div>
  )
}

function LogConsole({ logs }: { logs: string[] }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  return (
    <div className="log-console" data-testid="log-console">
      {logs.length === 0 ? (
        <div className="log-console-empty">No logs yet.</div>
      ) : (
        logs.map((line, i) => (
          <div key={i} className="log-console-line">
            {line}
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  )
}

export default App

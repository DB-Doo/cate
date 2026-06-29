export interface CanvasControlAdapter {
  createPanel(kind: string, options?: unknown): Promise<unknown>
  openFile(path: string, opts?: { line?: number; column?: number }): Promise<unknown>
  describeCapabilities(): Promise<Record<string, unknown>>
}

export interface TerminalControlAdapter {
  available(): Promise<boolean>
  openTerminal(options?: unknown): Promise<unknown>
  write(terminalId: string, input: string): Promise<unknown>
  read(terminalId: string): Promise<string>
}

export interface BrowserControlAdapter {
  available(): Promise<boolean>
  openBrowser(url?: string): Promise<unknown>
  navigate(browserId: string, url: string): Promise<unknown>
  inspect(browserId: string): Promise<unknown>
}

export interface CapabilityReport {
  currentApis: string[]
  partialApis: string[]
  futureApis: string[]
  adapters: {
    canvas: { available: true; detail: string }
    terminal: { available: false; detail: string }
    browser: { available: false; detail: string }
  }
}

const TERMINAL_UNAVAILABLE = 'Terminal control is not exposed by the current Cate extension host API.'
const BROWSER_UNAVAILABLE = 'Browser control is not exposed by the current Cate extension host API.'

export const unavailableTerminalAdapter: TerminalControlAdapter = {
  async available() {
    return false
  },
  async openTerminal() {
    throw new Error(TERMINAL_UNAVAILABLE)
  },
  async write() {
    throw new Error(TERMINAL_UNAVAILABLE)
  },
  async read() {
    throw new Error(TERMINAL_UNAVAILABLE)
  },
}

export const unavailableBrowserAdapter: BrowserControlAdapter = {
  async available() {
    return false
  },
  async openBrowser() {
    throw new Error(BROWSER_UNAVAILABLE)
  },
  async navigate() {
    throw new Error(BROWSER_UNAVAILABLE)
  },
  async inspect() {
    throw new Error(BROWSER_UNAVAILABLE)
  },
}

export async function createCapabilityReport(): Promise<CapabilityReport> {
  return {
    currentApis: [
      'cate.workspace.get',
      'cate.storage',
      'cate.storage.panel',
      'cate.theme.get',
      'cate.ui.notify',
      'cate.editor.openFile',
      'cate.canvas.createPanel',
      'cate.agent.run',
      'cate.agent.open',
      'cate.agent.send',
      'cate.agent.dispose',
    ],
    partialApis: ['cate.canvas.createPanel accepts public panel types only'],
    futureApis: [
      'terminal.createPanel',
      'terminal.write',
      'terminal.read',
      'browser.createPanel',
      'browser.navigate',
      'browser.inspect',
      'canvas.focusPanel',
      'canvas.centerPanel',
    ],
    adapters: {
      canvas: { available: true, detail: 'Uses cate.canvas.createPanel and cate.editor.openFile.' },
      terminal: { available: false, detail: TERMINAL_UNAVAILABLE },
      browser: { available: false, detail: BROWSER_UNAVAILABLE },
    },
  }
}

export interface PromptTask {
  id: number
  title: string
  status: string
  description?: string
}

export interface BuildAgentPromptInput {
  action: string
  workspaceRoot: string | null
  branch: string | null
  worktree: string | null
  notes: string
  selectedTask?: PromptTask | null
  projectSignals: string[]
  userPrompt: string
}

export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  const lines = [
    `Action: ${input.action}`,
    `Workspace root: ${input.workspaceRoot ?? '(none)'}`,
    `Branch: ${input.branch ?? '(unknown)'}`,
    `Worktree: ${input.worktree ?? '(unknown)'}`,
    `Project signals: ${input.projectSignals.length ? input.projectSignals.join(', ') : '(none detected)'}`,
    '',
    'Mission notes:',
    input.notes.trim() || '(none)',
  ]

  if (input.selectedTask) {
    lines.push(
      '',
      `Selected task: Task ${input.selectedTask.id}: ${input.selectedTask.title}`,
      `Task status: ${input.selectedTask.status}`,
      `Task description: ${input.selectedTask.description?.trim() || '(none)'}`,
    )
  }

  lines.push('', 'User request:', input.userPrompt.trim() || '(use the selected action)')
  return lines.join('\n')
}

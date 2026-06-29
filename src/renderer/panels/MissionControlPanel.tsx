import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { PanelProps } from './types'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Rocket, ArrowsClockwise, Copy, Check, Robot } from '@phosphor-icons/react'
import {
  buildAgentPrompt,
  createCapabilityReport,
  extractFileRefs,
  parseBoardText,
  TASKS_RELATIVE_PATH,
  LEGACY_TASKS_RELATIVE_PATH,
  type Board,
} from '../../shared/missionControl/index.js'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { getActiveCanvasOps } from '../lib/workspace/canvasAccess'
import type { Point, PanelPlacement } from '../../shared/types'

interface WorkspaceSummary {
  rootPath: string | null
  branch: string | null
  worktree: string | null
  projectSignals: string[]
}

interface TaskBoard {
  path: string | null
  board: Board | null
}

const ACTION_OPTIONS = [
  { value: 'investigate-project', label: 'Investigate project' },
  { value: 'summarize-status', label: 'Summarize status' },
  { value: 'plan-next-work', label: 'Plan next work' },
  { value: 'work-selected-task', label: 'Work selected task' },
  { value: 'review-changes', label: 'Review changes' },
]

const MissionControlPanel: React.FC<PanelProps> = ({ panelId, workspaceId }) => {
  const workspace = useAppStore((s) => s.getWorkspace(workspaceId))
  const rootPath = workspace?.rootPath ?? null

  const notesKey = `missionControl:notes:${workspaceId}`
  const selectedTaskIdKey = `missionControl:selectedTaskId:${workspaceId}`

  const notes = useSettingsStore((s) => ((s as unknown) as Record<string, unknown>)[notesKey] as string | undefined) ?? ''
  const selectedTaskId = useSettingsStore((s) => ((s as unknown) as Record<string, unknown>)[selectedTaskIdKey] as number | undefined) ?? null
  const setSetting = useSettingsStore((s) => s.setSetting)

  const [summary, setSummary] = useState<WorkspaceSummary>({ rootPath: null, branch: null, worktree: null, projectSignals: [] })
  const [taskBoard, setTaskBoard] = useState<TaskBoard>({ path: null, board: null })
  const [capabilities, setCapabilities] = useState<unknown>(null)
  const [action, setAction] = useState('work-selected-task')
  const [userPrompt, setUserPrompt] = useState('')
  const [output, setOutput] = useState('')
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)

  const loadSummary = useCallback(async () => {
    if (!rootPath) return
    const fs = window.electronAPI
    const signals: string[] = []
    const candidates = [
      '.git',
      'package.json',
      'pubspec.yaml',
      'Cargo.toml',
      'pyproject.toml',
      'go.mod',
      '.taskmaster/tasks/tasks.json',
    ]
    for (const candidate of candidates) {
      try {
        const stat = await fs.fsStat(`${rootPath}/${candidate}`, workspaceId)
        if (stat.isFile || stat.isDirectory) signals.push(candidate)
      } catch {
        // ignore missing
      }
    }
    let branch: string | null = null
    let worktree: string | null = null
    try {
      const gitStatus = await fs.gitStatus(rootPath)
      branch = gitStatus.current
    } catch {
      // not a git repo or git unavailable
    }
    try {
      const worktrees = await fs.gitWorktreeList(rootPath)
      const current = worktrees.find((wt) => wt.isCurrent)
      if (current) worktree = current.path
    } catch {
      // ignore
    }
    setSummary({ rootPath, branch, worktree, projectSignals: signals })
  }, [rootPath, workspaceId])

  const loadTasks = useCallback(async () => {
    if (!rootPath) return
    const fs = window.electronAPI
    for (const rel of [TASKS_RELATIVE_PATH, LEGACY_TASKS_RELATIVE_PATH]) {
      try {
        const text = await fs.fsReadFile(`${rootPath}/${rel}`, workspaceId)
        setTaskBoard({ path: rel, board: parseBoardText(text) })
        return
      } catch {
        // try next path
      }
    }
    setTaskBoard({ path: null, board: null })
  }, [rootPath, workspaceId])

  const loadCapabilities = useCallback(async () => {
    setCapabilities(await createCapabilityReport())
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      await Promise.all([loadSummary(), loadTasks(), loadCapabilities()])
    } finally {
      setLoading(false)
    }
  }, [loadSummary, loadTasks, loadCapabilities])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selectedTask = useMemo(() => {
    if (!taskBoard.board || selectedTaskId == null) return null
    for (const tag of taskBoard.board.tags) {
      for (const task of tag.tasks) {
        if (task.id === selectedTaskId) return task
      }
    }
    return null
  }, [taskBoard.board, selectedTaskId])

  const prompt = useMemo(() => {
    return buildAgentPrompt({
      action,
      workspaceRoot: summary.rootPath,
      branch: summary.branch,
      worktree: summary.worktree,
      notes,
      selectedTask: selectedTask
        ? {
            id: selectedTask.id,
            title: selectedTask.title,
            status: selectedTask.status,
            description: selectedTask.description,
          }
        : null,
      projectSignals: summary.projectSignals,
      userPrompt,
    })
  }, [action, summary, notes, selectedTask, userPrompt])

  const copyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      setOutput('Prompt copied to clipboard.')
    } catch (err) {
      setOutput(`Copy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [prompt])

  const openAgentPanel = useCallback(async () => {
    if (!workspaceId || !rootPath) return
    setOutput('Opening agent panel...')
    try {
      // Place the agent panel next to this Mission Control node on the same
      // canvas so it opens immediately instead of triggering the placement
      // picker when no position is provided.
      let placement: PanelPlacement | undefined
      const ops = getActiveCanvasOps()
      if (ops) {
        const nodes = Object.values(ops.storeApi.getState().nodes)
        const mcNode = nodes.find((n) => n.panelId === panelId)
        if (mcNode) {
          const position: Point = {
            x: mcNode.origin.x + mcNode.size.width + 24,
            y: mcNode.origin.y,
          }
          placement = { target: 'canvas', position }
        }
      }

      const agentPanelId = useAppStore.getState().createAgent(workspaceId, undefined, placement)
      if (!agentPanelId) {
        setOutput('Failed to create agent panel.')
        return
      }
      const res = await window.electronAPI.agentCreate({ panelId: agentPanelId, workspaceId, cwd: rootPath })
      if (!res.ok) {
        setOutput(`Agent create failed: ${res.error}`)
        return
      }
      await window.electronAPI.agentPrompt(agentPanelId, prompt)
      setOutput('Agent panel opened and prompt sent.')
    } catch (err) {
      setOutput(`Agent error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [workspaceId, rootPath, prompt, panelId])

  const openFile = useCallback(
    (path: string, _line?: number) => {
      if (!rootPath) return
      openFileAsPanel(workspaceId, `${rootPath}/${path}`)
    },
    [rootPath, workspaceId],
  )

  const defaultTag = taskBoard.board?.tags[0]
  const tag = taskBoard.board?.tags.find((t) => t.tag === taskBoard.board?.defaultTag) ?? defaultTag

  return (
    <div className="flex flex-col h-full bg-surface-4 text-primary overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-subtle bg-surface-3">
        <div className="flex items-center gap-2">
          <Rocket size={16} className="text-orange-400" />
          <span className="text-sm font-semibold">Mission Control</span>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-secondary hover:text-primary disabled:opacity-50"
        >
          <ArrowsClockwise size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Status */}
        <div className="rounded-md border border-subtle bg-surface-3 p-3 text-xs space-y-1">
          <div className="text-secondary">Workspace: <span className="text-primary">{summary.rootPath ?? '(none)'}</span></div>
          <div className="text-secondary">Branch: <span className="text-primary">{summary.branch ?? '(unknown)'}</span></div>
          <div className="text-secondary">Worktree: <span className="text-primary">{summary.worktree ?? '(unknown)'}</span></div>
          <div className="text-secondary">Signals: <span className="text-primary">{summary.projectSignals.join(', ') || '(none)'}</span></div>
        </div>

        {/* Notes */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-secondary uppercase tracking-wide">Mission Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setSetting(notesKey as never, e.target.value as never)}
            className="w-full h-24 bg-surface-2 border border-subtle rounded-md p-2 text-sm text-primary placeholder:text-muted resize-none focus:outline-none focus:ring-1 focus:ring-orange-400"
            placeholder="Add context, goals, constraints..."
          />
        </div>

        {/* Agent Launcher */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-secondary uppercase tracking-wide">Agent Launcher</label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-full bg-surface-2 border border-subtle rounded-md p-2 text-sm text-primary focus:outline-none focus:ring-1 focus:ring-orange-400"
          >
            {ACTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <textarea
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            className="w-full h-20 bg-surface-2 border border-subtle rounded-md p-2 text-sm text-primary placeholder:text-muted resize-none focus:outline-none focus:ring-1 focus:ring-orange-400"
            placeholder="Add any specific request..."
          />
          <div className="flex gap-2">
            <button
              onClick={() => void copyPrompt()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-2 hover:bg-surface-1 border border-subtle rounded-md text-primary"
            >
              {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy Prompt'}
            </button>
            <button
              onClick={() => void openAgentPanel()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/40 rounded-md text-orange-200"
            >
              <Robot size={12} />
              Open Agent Panel
            </button>
          </div>
          {output && (
            <div className="text-xs text-secondary whitespace-pre-wrap">{output}</div>
          )}
        </div>

        {/* Tasks */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-secondary uppercase tracking-wide">Project Tasks</label>
          {!tag || tag.tasks.length === 0 ? (
            <div className="text-xs text-muted">No .taskmaster/tasks/tasks.json file found for this workspace.</div>
          ) : (
            <div className="space-y-1">
              {tag.tasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => setSetting(selectedTaskIdKey as never, task.id as never)}
                  className={`w-full text-left p-2 rounded-md border border-subtle text-xs space-y-1 transition-colors ${
                    selectedTaskId === task.id ? 'bg-orange-500/20 border-orange-500/40' : 'bg-surface-3 hover:bg-surface-2'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-primary">{task.id}. {task.title}</span>
                    <span className="text-muted">{task.status}</span>
                  </div>
                  {task.description && (
                    <TaskDescription text={task.description} onOpenFile={openFile} />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Capabilities */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-secondary uppercase tracking-wide">Capabilities</label>
          <pre className="text-xs text-secondary bg-surface-3 border border-subtle rounded-md p-2 overflow-auto max-h-48">
            {capabilities ? JSON.stringify(capabilities, null, 2) : 'Loading...'}
          </pre>
        </div>
      </div>
    </div>
  )
}

export default MissionControlPanel

function TaskDescription({ text, onOpenFile }: { text: string; onOpenFile: (path: string, line?: number) => void }) {
  const refs = useMemo(() => extractFileRefs(text), [text])
  if (refs.length === 0) {
    return <div className="text-muted line-clamp-2">{text}</div>
  }

  const parts: React.ReactNode[] = []
  let last = 0
  for (const ref of refs) {
    const idx = text.indexOf(ref.path, last)
    if (idx === -1) continue
    if (idx > last) parts.push(<span key={`pre-${idx}`}>{text.slice(last, idx)}</span>)
    parts.push(
      <button
        key={`ref-${idx}`}
        onClick={() => onOpenFile(ref.path, ref.line)}
        className="text-orange-300 hover:text-orange-200 underline"
      >
        {ref.path}{ref.line ? `:${ref.line}` : ''}
      </button>,
    )
    last = idx + ref.path.length + (ref.line ? String(ref.line).length + 1 : 0)
  }
  if (last < text.length) parts.push(<span key="end">{text.slice(last)}</span>)
  return <div className="text-muted line-clamp-2">{parts}</div>
}

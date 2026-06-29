import { describe, expect, it } from 'vitest'
import {
  buildAgentPrompt,
  createCapabilityReport,
  unavailableBrowserAdapter,
  unavailableTerminalAdapter,
} from './capabilities.js'

describe('createCapabilityReport', () => {
  it('marks terminal and browser driving as unavailable in V1', async () => {
    const report = await createCapabilityReport()
    expect(report.adapters.terminal.available).toBe(false)
    expect(report.adapters.browser.available).toBe(false)
    expect(report.currentApis).toContain('cate.agent.run')
    expect(report.futureApis).toContain('terminal.write')
  })
})

describe('unavailable adapters', () => {
  it('return explicit unavailable explanations', async () => {
    await expect(unavailableTerminalAdapter.openTerminal()).rejects.toThrow('Terminal control is not exposed')
    await expect(unavailableBrowserAdapter.openBrowser()).rejects.toThrow('Browser control is not exposed')
  })
})

describe('buildAgentPrompt', () => {
  it('combines workspace, notes, selected task, signals, and user prompt', () => {
    const prompt = buildAgentPrompt({
      action: 'work-selected-task',
      workspaceRoot: '/home/dan/Projects/demo',
      branch: 'main',
      worktree: 'demo',
      notes: 'Keep it simple.',
      selectedTask: { id: 4, title: 'Add tests', status: 'pending', description: 'Cover parser.' },
      projectSignals: ['package.json', '.git'],
      userPrompt: 'Start with parser tests.',
    })

    expect(prompt).toContain('/home/dan/Projects/demo')
    expect(prompt).toContain('Task 4: Add tests')
    expect(prompt).toContain('Keep it simple.')
    expect(prompt).toContain('Start with parser tests.')
  })
})

import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './fixtures/electron-app'
import type { ElectronApplication, Page } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let app: ElectronApplication
let page: Page
let tmpRoot: string

test.beforeEach(async () => {
  ;({ electronApp: app, mainWindow: page } = await launchApp())
})

test.afterEach(async () => {
  await closeApp(app)
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Mission Control panel renders and opens an agent panel', async () => {
  // Seed a workspace root with project signals and a Task Master board.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-mc-smoke-'))
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}')
  fs.mkdirSync(path.join(tmpRoot, '.git'))
  fs.mkdirSync(path.join(tmpRoot, '.taskmaster', 'tasks'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpRoot, '.taskmaster', 'tasks', 'tasks.json'),
    JSON.stringify({
      master: {
        tasks: [
          {
            id: 1,
            title: 'Smoke test task',
            description: 'Verify Mission Control integration.',
            status: 'in-progress',
            dependencies: [],
            subtasks: [],
          },
        ],
      },
    }),
  )

  await page.evaluate((rootPath) => window.__cateE2E!.setWorkspaceRoot(rootPath), tmpRoot)
  await page.waitForTimeout(200)

  // Create a Mission Control node on the active canvas.
  const nodeId = await page.evaluate((p) => window.__cateE2E!.createMissionControl(p), {
    x: 200,
    y: 150,
  })
  expect(nodeId).toBeTruthy()
  await page.waitForSelector(`[data-node-id="${nodeId}"]`, { timeout: 5000 })

  const nodeHandle = await page.$(`[data-node-id="${nodeId}"]`)
  expect(nodeHandle).not.toBeNull()

  const text = await nodeHandle!.textContent()
  expect(text).toContain('Mission Control')
  expect(text).toContain('package.json')
  expect(text).toContain('Smoke test task')

  // Click "Open Agent Panel" inside the Mission Control panel.
  const openAgentBtn = await nodeHandle!.$('text=Open Agent Panel')
  expect(openAgentBtn).not.toBeNull()
  await openAgentBtn!.waitForElementState('visible')
  await openAgentBtn!.evaluate((b) => (b as HTMLElement).click())

  // Wait for a second canvas node (the agent panel) to appear.
  await page.waitForFunction(
    (mcNodeId) => {
      const nodes = window.__cateE2E!.nodes()
      return nodes.length >= 2 && nodes.some((n) => n.id !== mcNodeId)
    },
    nodeId,
    { timeout: 15000 },
  )
})

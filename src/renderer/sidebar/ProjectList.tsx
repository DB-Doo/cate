import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Plus } from '@phosphor-icons/react'
import { useAppStore, useWorkspaceList } from '../stores/appStore'
import { WorkspaceTab } from './WorkspaceTab'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import type { NativeContextMenuItem } from '../../shared/electron-api.d'

export const ProjectList: React.FC = () => {
  const workspaces = useWorkspaceList()
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)

  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set())
  const lastClickedIndexRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Clear multi-selection when workspaces change (e.g. after deletion)
  useEffect(() => {
    setMultiSelected((prev) => {
      const wsIds = new Set(workspaces.map((w) => w.id))
      const filtered = new Set([...prev].filter((id) => wsIds.has(id)))
      if (filtered.size === prev.size) return prev
      return filtered
    })
  }, [workspaces])

  const handleWorkspaceClick = useCallback((index: number, wsId: string, e?: React.MouseEvent) => {
    if (e?.shiftKey && lastClickedIndexRef.current !== null) {
      const start = Math.min(lastClickedIndexRef.current, index)
      const end = Math.max(lastClickedIndexRef.current, index)
      const rangeIds = new Set<string>()
      for (let i = start; i <= end; i++) {
        rangeIds.add(workspaces[i].id)
      }
      setMultiSelected(rangeIds)
      return
    }

    setMultiSelected(new Set())
    lastClickedIndexRef.current = index
    selectWorkspace(wsId)
  }, [workspaces, selectWorkspace])

  const handleBulkDelete = useCallback(() => {
    if (multiSelected.size === 0) return
    const idsToRemove = [...multiSelected]
    setMultiSelected(new Set())
    lastClickedIndexRef.current = null
    for (const id of idsToRemove) {
      useAppStore.getState().removeWorkspace(id)
    }
  }, [multiSelected])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && multiSelected.size > 0) {
      e.preventDefault()
      handleBulkDelete()
    }
    if (e.key === 'Escape' && multiSelected.size > 0) {
      e.preventDefault()
      setMultiSelected(new Set())
    }
  }, [multiSelected, handleBulkDelete])

  const handleBulkContextMenu = useCallback(async (e: React.MouseEvent, wsId: string) => {
    if (multiSelected.size < 2) return false
    if (!multiSelected.has(wsId)) return false
    e.preventDefault()
    e.stopPropagation()
    if (!window.electronAPI) return true
    const items: NativeContextMenuItem[] = [
      { id: 'delete-selected', label: `Close ${multiSelected.size} Workspaces` },
    ]
    const id = await window.electronAPI.showContextMenu(items)
    if (id === 'delete-selected') {
      handleBulkDelete()
    }
    return true
  }, [multiSelected, handleBulkDelete])

  const handleNewWorkspace = useCallback(() => {
    const existing = useAppStore.getState().workspaces.find((w) => !w.rootPath)
    const wsId = existing ? existing.id : addWorkspace()
    selectWorkspace(wsId)
    setMultiSelected(new Set())
  }, [addWorkspace, selectWorkspace])

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const displayWorkspaces = workspaces

  return (
    <div
      className="flex flex-col h-full"
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <SidebarSectionHeader
        title="Workspace"
        actions={
          <SidebarHeaderButton onClick={handleNewWorkspace} title="New Workspace">
            <Plus size={14} weight="bold" />
          </SidebarHeaderButton>
        }
      />

      {/* Scrollable workspace list */}
      <div className="flex-1 overflow-y-auto px-1 py-1">
        <div className="flex flex-col">
          {displayWorkspaces.map((ws, index) => (
            <div
              key={ws.id}
              draggable={multiSelected.size === 0}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', String(index))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragOverIndex(index)
              }}
              onDragLeave={() => setDragOverIndex(null)}
              onDrop={(e) => {
                e.preventDefault()
                const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10)
                if (!isNaN(fromIndex) && fromIndex !== index) {
                  useAppStore.getState().reorderWorkspaces(fromIndex, index)
                }
                setDragOverIndex(null)
              }}
              style={{
                borderTop: dragOverIndex === index ? '2px solid rgba(74, 158, 255, 0.6)' : '2px solid transparent',
                transition: 'border-color 0.15s',
              }}
            >
              <WorkspaceTab
                workspace={ws}
                isSelected={ws.id === selectedWorkspaceId}
                isMultiSelected={multiSelected.has(ws.id)}
                onClick={(e) => handleWorkspaceClick(index, ws.id, e)}
                onClose={() => removeWorkspace(ws.id)}
                onBulkContextMenu={(e) => handleBulkContextMenu(e, ws.id)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

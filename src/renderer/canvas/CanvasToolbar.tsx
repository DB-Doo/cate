// =============================================================================
// CanvasToolbar — floating bottom-center toolbar for panel creation and zoom.
// Ported from CanvasToolbar.swift.
// =============================================================================

import React, { useState, useRef, useEffect } from 'react'
import {
  Terminal,
  Globe,
  FileText,
  Minus,
  Plus,
  Sparkle,
  Square,
  ArrowsOutSimple,
  DotsThree,
  SquaresFour,
  MapTrifold,
  X,
} from '@phosphor-icons/react'
import Minimap from './Minimap'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useUIStore } from '../stores/uiStore'
import { UpdateButton } from './UpdateButton'

interface CanvasToolbarProps {
  zoom: number
  onNewTerminal: () => void
  onNewBrowser: () => void
  onNewEditor: () => void
  onNewAgent: () => void
  onNewCanvas: () => void
  onNewRegion: () => void
  onAutoLayout: () => void
  onZoomToFit: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}

const ToolbarButton: React.FC<{
  onClick: () => void
  title: string
  size?: 'panel' | 'zoom'
  active?: boolean
  children: React.ReactNode
}> = ({ onClick, title, size = 'panel', active = false, children }) => {
  const sizeClass = size === 'panel' ? 'w-7 h-7' : 'w-6 h-6'
  const activeClass = active ? 'bg-hover-strong' : 'bg-transparent'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{ WebkitTapHighlightColor: 'transparent' }}
      className={`${sizeClass} ${activeClass} flex items-center justify-center rounded-full text-primary hover:bg-hover-strong active:bg-hover-strong active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100`}
    >
      {children}
    </button>
  )
}

const MenuItem: React.FC<{
  onClick: () => void
  icon: React.ReactNode
  label: string
}> = ({ onClick, icon, label }) => (
  <button
    type="button"
    onClick={onClick}
    style={{ WebkitTapHighlightColor: 'transparent' }}
    className="group w-full flex items-center justify-between gap-3 px-2.5 py-1 rounded-md text-left text-[13px] text-primary bg-transparent hover:bg-focus-blue hover:text-inverse focus:outline-none focus-visible:outline-none transition-colors"
  >
    <span>{label}</span>
    <span className="w-4 h-4 flex items-center justify-center opacity-80 group-hover:opacity-100">{icon}</span>
  </button>
)

const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  zoom,
  onNewTerminal,
  onNewBrowser,
  onNewEditor,
  onNewAgent,
  onNewCanvas,
  onNewRegion,
  onAutoLayout,
  onZoomToFit,
  onZoomIn,
  onZoomOut,
}) => {
  const canvasApi = useCanvasStoreApi()
  const minimapOpen = useUIStore((s) => s.minimapOpen)
  const toggleMinimapOpen = useUIStore((s) => s.toggleMinimapOpen)
  const zoomText = `${Math.round(zoom * 100)}%`

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close drop-up on outside click / Escape
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const pick = (fn: () => void) => () => {
    fn()
    setMenuOpen(false)
  }

  return (
    <>
    <div
      className="absolute bottom-4 z-50 flex justify-center pointer-events-none"
      style={{
        left: 'var(--cate-left-sidebar-width, 0px)',
        right: 'var(--cate-right-sidebar-width, 0px)',
      }}
    >
      <div ref={menuRef} className="relative pointer-events-auto">
        {/* Drop-up menu */}
        {menuOpen && (
          <div
            data-theme="dark-warm"
            className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 min-w-[200px] rounded-lg border border-subtle bg-surface-4/95 backdrop-blur-xl backdrop-saturate-150 shadow-[0_10px_30px_-10px_var(--shadow-node)] p-1"
          >
            <MenuItem
              onClick={pick(onNewRegion)}
              icon={<Square size={16} />}
              label="New Region"
            />
            <div className="h-px bg-surface-5 my-1" />
            <MenuItem
              onClick={pick(onAutoLayout)}
              icon={<SquaresFour size={16} />}
              label="Auto Layout"
            />
            <MenuItem
              onClick={pick(onZoomToFit)}
              icon={<ArrowsOutSimple size={16} />}
              label="Zoom to Fit"
            />
          </div>
        )}

        <div className="rounded-full border border-strong bg-surface-6 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
          <div className="flex items-center gap-1 px-3 py-1.5">
            {/* Basic panel buttons */}
            <ToolbarButton onClick={onNewTerminal} title="Terminal" size="panel">
              <Terminal size={14} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewBrowser} title="Browser" size="panel">
              <Globe size={14} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewEditor} title="Editor" size="panel">
              <FileText size={14} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewAgent} title="Pi Agent" size="panel">
              <Sparkle size={14} weight="fill" />
            </ToolbarButton>

            {/* Divider */}
            <div className="w-px h-4 bg-surface-5 mx-0.5" />

            {/* More — opens drop-up with extra creators */}
            <ToolbarButton
              onClick={() => setMenuOpen((v) => !v)}
              title="More…"
              size="panel"
              active={menuOpen}
            >
              <DotsThree size={14} />
            </ToolbarButton>

            {/* Zoom controls */}
            <ToolbarButton onClick={onZoomOut} title="Zoom Out" size="zoom">
              <Minus size={12} />
            </ToolbarButton>
            <button
              type="button"
              onClick={() => canvasApi.getState().animateZoomTo(1.0)}
              title="Reset zoom to 100%"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              className="text-[10px] font-mono text-primary min-w-[38px] text-center select-none rounded-full bg-transparent hover:bg-hover-strong active:bg-hover-strong cursor-pointer px-1 py-0.5 focus:outline-none focus-visible:outline-none transition-all duration-100"
            >
              {zoomText}
            </button>
            <ToolbarButton onClick={onZoomIn} title="Zoom In" size="zoom">
              <Plus size={12} />
            </ToolbarButton>
          </div>
        </div>
      </div>

    </div>

    {/* Minimap — pill button anchored to bottom-right that grows upward-left
        to reveal the map. The button stays at the bottom-right corner so open
        and close feel like the same gesture. */}
    <div
      className="absolute bottom-4 z-50 flex items-end gap-2"
      style={{ right: 'calc(1rem + var(--cate-right-sidebar-width, 0px))' }}
    >
      <UpdateButton />
      <div
        data-testid="minimap-toggle"
        className="relative overflow-hidden border border-strong shadow-[0_8px_24px_-6px_var(--shadow-node)]"
        style={{
          borderRadius: 20,
          transition: 'width 300ms cubic-bezier(0.16,1,0.3,1), height 300ms cubic-bezier(0.16,1,0.3,1), background 200ms ease, backdrop-filter 200ms ease',
          width: minimapOpen ? 220 : 36,
          height: minimapOpen ? 160 : 36,
          background: minimapOpen
            ? 'color-mix(in srgb, var(--surface-2) 45%, transparent)'
            : 'var(--surface-6)',
          backdropFilter: minimapOpen ? 'blur(24px) saturate(1.5)' : 'none',
          WebkitBackdropFilter: minimapOpen ? 'blur(24px) saturate(1.5)' : 'none',
        }}
      >
        {minimapOpen && (
          <div className="absolute inset-0">
            <Minimap mode="popover" />
          </div>
        )}
        <button
          type="button"
          onClick={toggleMinimapOpen}
          title={minimapOpen ? 'Hide minimap' : 'Show minimap'}
          style={{ WebkitTapHighlightColor: 'transparent' }}
          className="absolute -bottom-[1px] -right-[1px] w-[36px] h-[36px] flex items-center justify-center text-primary hover:text-primary/80 active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100 z-10"
        >
          {minimapOpen ? <X size={12} weight="bold" /> : <MapTrifold size={14} />}
        </button>
      </div>
    </div>
    </>
  )
}

export default React.memo(CanvasToolbar)

/**
 * Desktop floating panel for DeepSeek Harness Desktop.
 *
 * A screen-edge widget that lives in the Electron shell (NOT inside the web
 * page), so it stays visible on the Windows desktop even when the main DSH
 * window is closed (hidden to tray), and floats above every other app.
 *
 * Behavior:
 * - fully hidden while idle: a SHORT white strip (three gray dots), fixed at
 *   the vertical middle of the right screen edge, slides smoothly out of
 *   the edge ONLY when the cursor hovers the middle band of the edge;
 * - clicking the strip slides the panel in from beyond the right edge;
 * - panel width = clamp(360, screenWidth / 5, 560);
 * - the panel hosts the real DSH web app, shares the main window's storage,
 *   reloads once shortly after boot and follows session switches via the
 *   storage bridge, so it shows the ongoing conversation;
 * - a floating 【收起】 button is injected into the panel page; leaving the
 *   panel auto-hides it (page-detected, main-process-verified);
 * - after the panel hides, the strip lingers ~1 s and then slides away.
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TRIGGER_W = 12
const TRIGGER_H = 160
const EDGE_ZONE = 12 // horizontal proximity to the right edge
const EDGE_BAND_HALF = 140 // vertical band around the screen middle
const PANEL_MIN_W = 360
const PANEL_MAX_W = 560
const STRIP_HIDE_DELAY_MS = 300
const STRIP_POST_PANEL_HIDE_MS = 1000
const PANEL_SLIDE_MS = 380
const STRIP_SLIDE_MS = 180
const SLIDE_STEP_MS = 8 // ~125 Hz drive rate: saturates 90/120/144 Hz displays
const PROXIMITY_POLL_MS = 100
const PANEL_FOLLOW_RELOAD_MS = 15000

const OPEN_CHANNEL = 'dsh-floating:open'
const TOGGLE_CHANNEL = 'dsh-floating:toggle'
const COLLAPSE_CHANNEL = 'dsh-floating:collapse'
const CHECK_LEAVE_CHANNEL = 'dsh-floating:check-leave'
const HOVER_CHANNEL = 'dsh-floating:hover'

/** Small diagnostics log so visibility problems are debuggable from disk. */
function fpLog(message) {
  try {
    appendFileSync(
      join(process.env.TEMP || '.', 'dsh-desktop-floating.log'),
      `${new Date().toISOString()} ${message}\n`,
      { encoding: 'utf8' },
    )
  } catch {
    /* diagnostics must never break the widget */
  }
}

let triggerWin = null
let panelWin = null
let panelVisible = false
let serviceUrl = ''
let stripShown = false
let hideStripTimer = null
let postHideTimer = null
/** Per-window slide timers so panel and strip animations never cancel each other. */
const slideTimers = new Map()

function preloadPath() {
  return fileURLToPath(new URL('./floating-preload.js', import.meta.url))
}

function triggerPage() {
  return fileURLToPath(new URL('./floating-trigger.html', import.meta.url))
}

/** Panel geometry derived from the primary display's work area. */
function geometry() {
  const wa = screen.getPrimaryDisplay().workArea
  const panelW = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Math.round(wa.width / 5)))
  return { wa, panelW }
}

/**
 * Ease-out slide of any window toward a full target bounds rectangle.
 * Every frame writes the COMPLETE bounds (x/y/width/height): partial
 * setBounds calls let Electron re-derive the size through DPI conversion,
 * which drifts the window larger on every call (the observed "grows each
 * click" bug).
 */
function slideWindowTo(win, targetBounds, duration, done) {
  if (!win || win.isDestroyed()) return
  const winId = win.id
  const previous = slideTimers.get(winId)
  if (previous !== undefined) clearTimeout(previous)
  slideTimers.delete(winId)
  const startX = win.getBounds().x
  const delta = targetBounds.x - startX
  if (Math.abs(delta) < 1) {
    try {
      win.setBounds(targetBounds)
    } catch {
      /* normalize immediately */
    }
    if (done) done()
    return
  }
  const startedAt = Date.now()
  const step = () => {
    slideTimers.delete(winId)
    if (!win || win.isDestroyed()) return
    const t = Math.min(1, (Date.now() - startedAt) / duration)
    const eased = 1 - Math.pow(1 - t, 3)
    try {
      win.setBounds({
        x: Math.round(startX + delta * eased),
        y: targetBounds.y,
        width: targetBounds.width,
        height: targetBounds.height,
      })
    } catch {
      /* the final snap below corrects any drift */
    }
    if (t >= 1) {
      try {
        win.setBounds(targetBounds)
      } catch {
        /* keep the log honest */
      }
      if (done) done()
      return
    }
    slideTimers.set(winId, setTimeout(step, SLIDE_STEP_MS))
  }
  step()
}

/** Slide the strip in from / back out beyond the right edge. */
function setStripShown(shown) {
  if (!triggerWin || triggerWin.isDestroyed()) return
  if (stripShown === shown) return
  stripShown = shown
  const { wa } = geometry()
  // Fixed geometry: vertical middle of the right edge; never drifts.
  const bounds = {
    x: shown ? wa.x + wa.width - TRIGGER_W : wa.x + wa.width,
    y: wa.y + Math.round((wa.height - TRIGGER_H) / 2),
    width: TRIGGER_W,
    height: TRIGGER_H,
  }
  try {
    if (shown) {
      triggerWin.setIgnoreMouseEvents(false)
      triggerWin.showInactive()
      slideWindowTo(triggerWin, bounds, STRIP_SLIDE_MS, () => {
        fpLog('strip shown')
      })
    } else {
      triggerWin.setIgnoreMouseEvents(true, { forward: true })
      slideWindowTo(triggerWin, bounds, STRIP_SLIDE_MS, () => {
        try {
          triggerWin.hide()
        } catch {
          /* ignore */
        }
        fpLog('strip hidden')
      })
    }
  } catch (error) {
    fpLog(`strip toggle failed: ${error.message}`)
  }
}

/** True when the cursor hovers the middle band of the far right edge. */
function cursorInEdgeZone() {
  const { wa } = geometry()
  const cursor = screen.getCursorScreenPoint()
  const centerY = wa.y + Math.round(wa.height / 2)
  return cursor.x >= wa.x + wa.width - EDGE_ZONE
    && cursor.x < wa.x + wa.width + 2
    && Math.abs(cursor.y - centerY) <= EDGE_BAND_HALF
}

function onZoneEnter() {
  if (panelVisible) return
  setStripShown(true)
}

function onZoneLeave() {
  if (panelVisible) return
  clearTimeout(hideStripTimer)
  hideStripTimer = setTimeout(() => {
    hideStripTimer = null
    if (!panelVisible) setStripShown(false)
  }, STRIP_HIDE_DELAY_MS)
}

function createTrigger() {
  const { wa } = geometry()
  triggerWin = new BrowserWindow({
    width: TRIGGER_W,
    height: TRIGGER_H,
    x: wa.x + wa.width, // parked beyond the edge; slides in on hover
    y: wa.y + Math.round((wa.height - TRIGGER_H) / 2),
    frame: false,
    // Opaque on purpose: transparent/layered windows are fragile when
    // wallpaper engines hook DWM/GPU (they can render as nothing at all).
    transparent: false,
    backgroundColor: '#ffffff',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    // The trigger must never steal keyboard focus from the user's current app.
    focusable: false,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  triggerWin.setAlwaysOnTop(true, 'screen-saver')
  triggerWin.loadFile(triggerPage())
  triggerWin.setIgnoreMouseEvents(true, { forward: true })
  fpLog(`trigger created @ y=${triggerWin.getBounds().y} w=${TRIGGER_W} h=${TRIGGER_H}`)
  setTimeout(() => {
    if (!triggerWin || triggerWin.isDestroyed()) return
    triggerWin.webContents.capturePage()
      .then((image) => {
        writeFileSync(join(process.env.TEMP || '.', 'dsh-trigger-shot.png'), image.toPNG())
        fpLog('trigger screenshot saved')
      })
      .catch((error) => fpLog(`trigger screenshot failed: ${error.message}`))
  }, 3000)
  triggerWin.on('closed', () => {
    triggerWin = null
  })

  // Z-order insurance: desktop widget / wallpaper layers keep re-raising
  // their own topmost windows; re-assert ours periodically. Skipped while a
  // slide animation is in flight so the raise never steals a frame.
  setInterval(() => {
    try {
      if (slideTimers.size > 0) return
      if (triggerWin && !triggerWin.isDestroyed() && triggerWin.isVisible() && stripShown) {
        triggerWin.moveTop()
      }
      if (panelWin && !panelWin.isDestroyed() && panelVisible && panelWin.isVisible()) {
        panelWin.moveTop()
      }
    } catch {
      /* z-order maintenance must never crash the widget */
    }
  }, 3000)
}

/** Inject 【收起】 button, in-page mouse-leave detection and session follow. */
function injectPanelHelpers() {
  if (!panelWin || panelWin.isDestroyed()) return
  const js = `(() => {
    try {
      if (!window.__dshFpHelpers) {
        const btn = document.createElement('button')
        btn.id = '__dsh-fp-collapse'
        btn.textContent = '»'
        btn.title = '收起 / Collapse'
        btn.setAttribute('aria-label', '收起 / Collapse')
        const style = {
          position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
          width: '30px', height: '30px', borderRadius: '50%',
          border: '1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.14))',
          background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
          color: 'var(--dsw-alias-label-primary, #0f172a)',
          cursor: 'pointer', fontSize: '15px', lineHeight: '1',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 10px rgba(0,0,0,.18)',
        }
        for (const [key, value] of Object.entries(style)) btn.style.setProperty(key, value)
        btn.addEventListener('click', () => { if (window.dshFloating) window.dshFloating.collapse() })
        ;(document.body || document.documentElement).appendChild(btn)

        // Auto-hide: page-detected mouse leave, verified by the main process.
        let leaveTimer = null
        const disarm = () => {
          if (leaveTimer !== null) { clearTimeout(leaveTimer); leaveTimer = null }
        }
        document.addEventListener('mouseout', (event) => {
          if (event.relatedTarget === null && leaveTimer === null) {
            leaveTimer = setTimeout(() => {
              leaveTimer = null
              if (window.dshFloating) window.dshFloating.checkLeave()
            }, 500)
          }
        })
        document.addEventListener('mouseover', disarm)
        document.addEventListener('mousedown', disarm)

        // Follow the main window's session selection (same storage origin:
        // storage events only fire in OTHER windows, so this never loops).
        window.addEventListener('storage', (event) => {
          if (event.key === 'dsh.sessions.current') location.reload()
        })

        window.__dshFpHelpers = true
      }
      return 'ok'
    } catch (error) {
      return 'error: ' + error.message
    }
  })()`
  panelWin.webContents.executeJavaScript(js).catch(() => {})
}

function createPanel() {
  const { wa, panelW } = geometry()
  panelWin = new BrowserWindow({
    width: panelW,
    height: wa.height,
    x: wa.x + wa.width, // parked fully beyond the right screen edge
    y: wa.y,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Deliberately NO partition: sharing the default partition means the
      // panel restores the same session selection as the main window.
    },
  })
  panelWin.setAlwaysOnTop(true, 'screen-saver')
  panelWin.webContents.on('did-finish-load', injectPanelHelpers)
  panelWin.on('closed', () => {
    panelWin = null
  })
}

/** Snapshot the panel content and dump its visible text for diagnostics. */
function capturePanelState() {
  setTimeout(() => {
    if (!panelWin || panelWin.isDestroyed() || !panelVisible) return
    panelWin.webContents.capturePage()
      .then((image) => {
        writeFileSync(join(process.env.TEMP || '.', 'dsh-panel-shot.png'), image.toPNG())
        fpLog('panel screenshot saved')
      })
      .catch((error) => fpLog(`panel screenshot failed: ${error.message}`))
    panelWin.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 800) : ""')
      .then((text) => {
        writeFileSync(join(process.env.TEMP || '.', 'dsh-panel-state.txt'), text, { encoding: 'utf8' })
        fpLog('panel text dump saved')
      })
      .catch(() => {})
  }, 1500)
}

function showPanel() {
  if (panelVisible) return
  if (serviceUrl === '') return
  if (!panelWin || panelWin.isDestroyed()) {
    createPanel()
    panelWin.loadURL(serviceUrl)
  } else {
    const current = panelWin.webContents.getURL()
    if (current === '' || current.startsWith('about:')) panelWin.loadURL(serviceUrl)
  }
  panelVisible = true
  setStripShown(false)
  panelWin.showInactive()
  const { wa, panelW } = geometry()
  const targetX = wa.x + wa.width - panelW
  slideWindowTo(panelWin, { x: targetX, y: wa.y, width: panelW, height: wa.height }, PANEL_SLIDE_MS, () => {
    const actual = panelWin ? panelWin.getBounds().x : 'null'
    fpLog(`panel shown target=${targetX} actual=${actual} w=${panelW}`)
    capturePanelState()
  })
}

function hidePanel() {
  if (!panelVisible) return
  panelVisible = false
  const { wa, panelW } = geometry()
  slideWindowTo(panelWin, { x: wa.x + wa.width, y: wa.y, width: panelW, height: wa.height }, PANEL_SLIDE_MS, () => {
    fpLog('panel hidden')
    if (triggerWin && !triggerWin.isDestroyed()) {
      // Per the requested flow: the strip reappears for about a second
      // after the panel hides, then slides away (unless the cursor is
      // already back at the edge band).
      setStripShown(true)
      clearTimeout(postHideTimer)
      postHideTimer = setTimeout(() => {
        postHideTimer = null
        if (!panelVisible && !cursorInEdgeZone()) setStripShown(false)
      }, STRIP_POST_PANEL_HIDE_MS)
    }
  })
}

/** Panel-side leave event verified against the real cursor position. */
function verifyLeave() {
  if (!panelVisible || !panelWin || panelWin.isDestroyed()) return
  const bounds = panelWin.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const inside = cursor.x >= bounds.x
    && cursor.x < bounds.x + bounds.width
    && cursor.y >= bounds.y
    && cursor.y < bounds.y + bounds.height
  if (!inside) {
    fpLog('verified cursor left panel -> hide')
    hidePanel()
  } else {
    fpLog('spurious leave event ignored')
  }
}

/**
 * Bring the desktop widget up once the DSH service URL is known.
 * The panel window is created and pre-loaded immediately so opening is
 * instant; the trigger strip stays hidden until the cursor hovers the
 * middle band of the right edge.
 */
export function startFloatingPanel(url) {
  serviceUrl = url
  ipcMain.removeAllListeners(OPEN_CHANNEL)
  ipcMain.removeAllListeners(TOGGLE_CHANNEL)
  ipcMain.removeAllListeners(COLLAPSE_CHANNEL)
  ipcMain.removeAllListeners(CHECK_LEAVE_CHANNEL)
  ipcMain.removeAllListeners(HOVER_CHANNEL)
  ipcMain.on(OPEN_CHANNEL, () => showPanel())
  ipcMain.on(TOGGLE_CHANNEL, () => {
    if (panelVisible) hidePanel()
    else showPanel()
  })
  ipcMain.on(COLLAPSE_CHANNEL, () => hidePanel())
  ipcMain.on(CHECK_LEAVE_CHANNEL, verifyLeave)
  ipcMain.on(HOVER_CHANNEL, () => fpLog('trigger hover received'))
  try {
    createTrigger()
    createPanel()
    panelWin.loadURL(serviceUrl)
    fpLog(`started: url=${serviceUrl} panel=${panelWin ? 'created' : 'null'} trigger=${triggerWin ? 'created' : 'null'}`)
  } catch (error) {
    fpLog(`start failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }

  // Background re-sync: reload the panel once shortly after boot so it
  // picks up the session the main window has selected (the main window
  // boots after the panel; its persisted selection may land later).
  setTimeout(() => {
    try {
      if (panelWin && !panelWin.isDestroyed() && !panelVisible) {
        panelWin.webContents.reload()
        fpLog('panel follow-reload done')
      }
    } catch (error) {
      fpLog(`panel follow-reload failed: ${error.message}`)
    }
  }, PANEL_FOLLOW_RELOAD_MS)

  // Edge-proximity reveal: the strip stays fully hidden until the cursor
  // hovers the middle band of the far right edge.
  let wasInZone = false
  setInterval(() => {
    if (panelVisible) {
      wasInZone = false
      return
    }
    const inZone = cursorInEdgeZone()
    if (inZone && !wasInZone) {
      fpLog('edge zone entered')
      onZoneEnter()
    } else if (!inZone && wasInZone) {
      fpLog('edge zone left')
      onZoneLeave()
    }
    wasInZone = inZone
  }, PROXIMITY_POLL_MS)
}

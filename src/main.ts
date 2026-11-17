import { waitForEvenAppBridge, OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { rgbaToGray } from './edges'
import { render, type Mode } from './render'
import { W, H, createPage, rebuildPage, sendFrame, setHint, resetTileCache } from './glasses'

const HINT =
  '线条视界\n\n单击：拍照 / 实时（手机相机已开时）\n长按：线条 → 素描 → 照片 → 测量 → 平面图\n上滑 / 下滑：灵敏度（照片＝亮度）\n双击：退出'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('video')
const preview = $<HTMLCanvasElement>('preview')
const pctx = preview.getContext('2d')!
const statusEl = $('status')
const liveBtn = $<HTMLButtonElement>('live')
const shotBtn = $<HTMLButtonElement>('shot')
const sens = $<HTMLInputElement>('sens')
const thick = $<HTMLInputElement>('thick')
const bright = $<HTMLInputElement>('bright')
try {
  const saved = localStorage.getItem('brightness')
  if (saved) bright.value = saved
} catch {}

const work = document.createElement('canvas')
work.width = W
work.height = H
const wctx = work.getContext('2d', { willReadFrequently: true })!

let bridge: EvenAppBridge | null = null
let stream: MediaStream | null = null
let running = false
let busy = false
let lastSource: CanvasImageSource | null = null // 最近一张静态照片（调参数时重算）

const status = (s: string) => {
  statusEl.textContent = s
  console.log('[status]', s)
}

const MODES: Mode[] = ['lines', 'sketch', 'photo']
const MODE_NAME: Record<Mode, string> = { lines: '线条', sketch: '素描', photo: '照片' }
let mode: Mode = (localStorage.getItem('mode') as Mode) || 'sketch'
const modeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-mode]'))
function setMode(m: Mode) {
  mode = m
  try { localStorage.setItem('mode', m) } catch {}
  modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === m))
  onOptionChange()
}
modeBtns.forEach((b) =>
  b.addEventListener('click', async () => {
    if (view !== 'camera') await setView('camera')
    setMode(b.dataset.mode as Mode)
  }),
)

{
  const qm = new URLSearchParams(location.search).get('mode') as Mode | null
  if (qm && ['lines', 'sketch', 'photo'].includes(qm)) mode = qm
}
const options = () => ({ mode, sensitivity: +sens.value, thickness: +thick.value, brightness: +bright.value })

/** 把任意来源（视频帧 / 照片）裁成 2:1 画到工作画布上 */
function drawCover(src: CanvasImageSource, sw: number, sh: number) {
  const target = W / H
  let cw = sw
  let ch = sw / target
  if (ch > sh) {
    ch = sh
    cw = sh * target
  }
  wctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H)
}

/** 处理一帧：边缘检测 → 手机预览 → 送到眼镜 */
async function processAndSend(src: CanvasImageSource, sw: number, sh: number) {
  const t0 = performance.now()
  drawCover(src, sw, sh)
  const { data } = wctx.getImageData(0, 0, W, H)
  return processGray(rgbaToGray(data, W, H), t0)
}

/** 灰阶画面（W×H，0-255）→ 眼镜 */
async function processGray(gray: Float32Array, t0 = performance.now(), minChange = 0) {
  const frame = render(gray, W, H, options())

  // 手机上的预览：绿色 16 阶，和眼镜看起来一样
  const out = pctx.createImageData(W, H)
  for (let i = 0; i < frame.length; i++) {
    const p = i * 4
    out.data[p + 1] = frame[i] * 17
    out.data[p + 3] = 255
  }
  pctx.putImageData(out, 0, 0)
  const t1 = performance.now()

  const logs = bridge ? await sendFrame(bridge, frame, minChange) : []
  const t2 = performance.now()
  const ok = logs.filter((l) => l.result === 'success').length
  const detail = logs
    .map((l) => `#${l.tile + 1} ${(l.ms / 1000).toFixed(1)}s ${(l.bytes / 1024).toFixed(0)}KB ${l.result === 'success' ? '✓' : l.result}`)
    .join('；')
  return { proc: t1 - t0, send: t2 - t1, sent: ok, total: logs.length, detail }
}

// ---------- 手机「G2 桥接」App（127.0.0.1:8765） ----------
const BRIDGE_URL = 'http://127.0.0.1:8765'
let liveSource: 'bridge' | 'webcam' | null = null

async function fetchT(url: string, ms = 2000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
  } finally {
    clearTimeout(t)
  }
}

async function bridgeCameraRunning(): Promise<boolean> {
  try {
    const j = await (await fetchT(`${BRIDGE_URL}/camera.json`, 1500)).json()
    return !!j.running
  } catch {
    return false
  }
}

let lastFrameId = ''
async function fetchBridgeFrame(): Promise<Float32Array | null> {
  const r = await fetchT(`${BRIDGE_URL}/frame.gray`, 3000)
  if (!r.ok) return null
  const id = r.headers.get('X-Frame-Id') || ''
  if (id && id === lastFrameId) return null
  lastFrameId = id
  const b = new Uint8Array(await r.arrayBuffer())
  if (b.length !== W * H) return null
  const g = new Float32Array(W * H)
  for (let i = 0; i < g.length; i++) g[i] = b[i]
  return g
}

async function bridgeLoop() {
  let fails = 0
  while (running && liveSource === 'bridge') {
    if (busy) {
      await new Promise((r) => setTimeout(r, 100))
      continue
    }
    busy = true
    try {
      const t0 = performance.now()
      const g = await fetchBridgeFrame()
      if (g && running && liveSource === 'bridge') {
        fails = 0
        // 有 4% 以上像素明显变化才重送该块
        const r = await processGray(g, t0, 0.04)
        const total = performance.now() - t0
        if (running && liveSource === 'bridge' && view === 'camera')
          status(`实时中（手机相机 · ${MODE_NAME[mode]}）· 这一帧 ${(total / 1000).toFixed(1)} 秒，更新 ${r.sent}/4 块`)
      }
    } catch (e) {
      if (++fails >= 3) status('连不上「G2 桥接」App 的相机，请确认它还在执行')
    } finally {
      busy = false
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ---------- 实时模式 ----------
async function startLive(): Promise<boolean> {
  if (view !== 'camera') await setView('camera')
  // 1) 优先用手机「G2 桥接」App 的实时相机
  if (await bridgeCameraRunning()) {
    liveSource = 'bridge'
    running = true
    lastSource = null
    lastFrameId = ''
    liveBtn.textContent = '暂停'
    bridgeLoop()
    return true
  }
  // 2) 退而求其次：网页摄像头（Even App 里通常不允许）
  if (!navigator.mediaDevices?.getUserMedia) return false
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  } catch (e) {
    console.warn('getUserMedia failed', e)
    return false
  }
  video.srcObject = stream
  await video.play().catch(() => {})
  liveSource = 'webcam'
  running = true
  lastSource = null
  liveBtn.textContent = '暂停'
  loop()
  return true
}

function stopLive() {
  running = false
  liveSource = null
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  liveBtn.textContent = '开始实时'
}

function pauseToggle() {
  if (!liveSource) return
  running = !running
  liveBtn.textContent = running ? '暂停' : '继续'
  if (running) liveSource === 'bridge' ? bridgeLoop() : loop()
  else status('已暂停（单击镜腿继续）')
}

async function loop() {
  while (running && liveSource === 'webcam') {
    if (busy || video.readyState < 2) {
      await new Promise((r) => setTimeout(r, 100))
      continue
    }
    busy = true
    try {
      const r = await processAndSend(video, video.videoWidth, video.videoHeight)
      const total = r.proc + r.send
      status(`实时中 · 每帧 ${(total / 1000).toFixed(1)} 秒（处理 ${r.proc.toFixed(0)}ms，传送 ${r.send.toFixed(0)}ms，更新 ${r.sent}/4 块）`)
    } catch (e) {
      console.error(e)
      status('出错了：' + e)
    } finally {
      busy = false
    }
    await new Promise((r) => setTimeout(r, 100)) // 图片发送间隔下限
  }
}

// ---------- 单张模式（Even App 原生相机） ----------
async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = src
  await img.decode()
  return img
}

async function processStill(img: HTMLImageElement) {
  lastSource = img
  busy = true
  try {
    status('处理中…')
    const r = await processAndSend(img, img.naturalWidth, img.naturalHeight)
    status(
      `已显示 · 处理 ${r.proc.toFixed(0)}ms，传送 ${r.send.toFixed(0)}ms，成功 ${r.sent}/${r.total} 块\n${r.detail || '（画面没变，没有重送）'}`,
    )
  } finally {
    busy = false
  }
}

async function takeShot() {
  if (busy) return
  if (liveSource) stopLive()
  if (view !== 'camera') await setView('camera')
  if (!bridge) {
    status('需要在 Even App 里打开才能用相机')
    return
  }
  status('打开相机…')
  const asset = await bridge.captureImageFromCamera()
  if (!asset) {
    status('已取消或没有相机权限')
    return
  }
  const img = await loadImage(`data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`)
  await processStill(img)
}

// ---------- AR 测量模式 ----------
type View = 'camera' | 'measure' | 'plan'
let view: View = 'camera'
let measureTimer: number | null = null
let lastMeasureText = ''
const measureBtn = $<HTMLButtonElement>('measure')
const SEG_LABEL = ['长', '宽', '高']
const planBtn = $<HTMLButtonElement>('plan')
let planTimer: number | null = null
let planBusy = false
let lastPlanId = ''

/** 手机 App 传来的名称是繁体，眼镜上统一显示简体 */
const toSimp = (t: string) => t.replace(/長/g, '长').replace(/寬/g, '宽')

function fmtCm(cm: number) {
  return cm >= 100 ? `${(cm / 100).toFixed(2)} m` : `${cm.toFixed(1)} cm`
}

function measureText(j: any): string {
  if (!j || !j.active) {
    const segs = (j?.segments ?? []) as { cm: number }[]
    if (!segs.length) return 'AR 测量\n\n请在手机「G2 桥接」App\n按「④ AR 测量」打开测量画面'
    // 测量画面已关闭：保留最后一次的结果
    const lines = ['AR 测量 · 最后一次结果']
    segs.forEach((sg: any, i) => lines.push(`${sg.label ? toSimp(sg.label) : SEG_LABEL[i] ?? `第${i + 1}段`}  ${fmtCm(sg.cm)}`))
    lines.push('', '（要继续量，请在手机按「④ AR 测量」）')
    return lines.join('\n')
  }
  const track = j.tracking === 'ok' ? '追踪正常' : j.tracking === 'lost' ? '追踪中断，请慢慢移回' : '寻找平面中…左右慢慢移动'
  const lines = [`AR 测量 · ${track}`]
  ;(j.segments as { cm: number; label?: string }[]).forEach((sg, i) => {
    lines.push(`${sg.label ? toSimp(sg.label) : SEG_LABEL[i] ?? `第${i + 1}段`}  ${fmtCm(sg.cm)}`)
  })
  if (j.live != null) lines.push(`瞄准中  +${fmtCm(j.live)}`)
  else if (j.tracking === 'ok' && !j.aim) lines.push('（准星没对到表面）')
  else if (j.points === 0 && j.tracking === 'ok') lines.push('准星对准第一个角落')
  lines.push('')
  lines.push('单击 标点 · 上滑 复原 · 下滑 清除 · 长按 换模式')
  return lines.join('\n')
}

async function pollMeasure() {
  let j: any = null
  try {
    j = await (await fetchT(`${BRIDGE_URL}/measure.json`, 1500)).json()
  } catch {
    j = null
  }
  const text = j ? measureText(j) : 'AR 测量\n\n连不上手机「G2 桥接」App\n请先打开它'
  if (text !== lastMeasureText) {
    lastMeasureText = text
    status(text)
    if (bridge) await setHint(bridge, text).catch(() => {})
  }
}

async function measureCmd(c: 'add' | 'undo' | 'clear') {
  try {
    await fetchT(`${BRIDGE_URL}/measure/cmd?c=${c}`, 1500)
  } catch {}
  pollMeasure()
}

// ---------- 仓库平面图模式 ----------
async function pollPlan() {
  if (planBusy || view !== 'plan') return
  planBusy = true
  try {
    const [jr, gr] = await Promise.all([
      fetchT(`${BRIDGE_URL}/plan.json`, 2000),
      fetchT(`${BRIDGE_URL}/plan.gray`, 3000),
    ])
    const j = await jr.json()
    const id = gr.headers.get('X-Frame-Id') || ''
    const b = new Uint8Array(await gr.arrayBuffer())
    if (view !== 'plan') return
    if (b.length === W * H && id !== lastPlanId) {
      lastPlanId = id
      const k = Math.min(10, Math.max(1, +bright.value)) / 10
      const frame = new Uint8Array(W * H)
      const out = pctx.createImageData(W, H)
      for (let i = 0; i < frame.length; i++) {
        const lv = Math.round(b[i] / 17)
        frame[i] = lv ? Math.max(1, Math.round(lv * k)) : 0
        out.data[i * 4 + 1] = frame[i] * 17
        out.data[i * 4 + 3] = 255
      }
      pctx.putImageData(out, 0, 0)
      if (bridge) await sendFrame(bridge, frame, 0.003)
    }
    const counts = `货架 ${j.racks} 排（${j.bays} 格）· 地堆 ${j.floorStacks} · 柱子 ${j.columns} · 墙 ${j.walls} · 门 ${j.doors}`
    status(
      j.active
        ? `平面图 · ${j.toolName}${j.zoomFollow ? ' · 跟随我' : ' · 全图'}\n${j.prompt}\n${counts}`
        : `平面图（手机「G2 桥接」按「⑤ 仓库平面图」开始标）\n${counts}`,
    )
  } catch {
    status('平面图：连不上手机「G2 桥接」App，请先打开它')
  } finally {
    planBusy = false
  }
}

async function planCmd(c: 'add' | 'undo' | 'zoom') {
  try {
    await fetchT(`${BRIDGE_URL}/plan/cmd?c=${c}`, 1500)
  } catch {}
  lastPlanId = ''
  setTimeout(pollPlan, 150)
}

async function setView(v: View) {
  if (v === view) return
  const prev = view
  view = v
  measureBtn.classList.toggle('on', v === 'measure')
  planBtn.classList.toggle('on', v === 'plan')
  modeBtns.forEach((b) => b.classList.toggle('on', v === 'camera' && b.dataset.mode === mode))
  if (planTimer) clearInterval(planTimer)
  planTimer = null
  if (measureTimer) clearInterval(measureTimer)
  measureTimer = null
  if (v === 'plan') {
    if (liveSource) stopLive()
    if (prev === 'measure' && bridge) await rebuildPage(bridge, 'image', '平面图\n\n连接中…').catch(() => {})
    resetTileCache()
    lastPlanId = ''
    await pollPlan()
    planTimer = window.setInterval(pollPlan, 700)
    return
  }
  if (v === 'measure') {
    if (liveSource) stopLive()
    lastMeasureText = ''
    // 换成只有文字的页面（图片会盖住文字）
    if (bridge) await rebuildPage(bridge, 'text', 'AR 测量\n\n连接中…').catch(() => {})
    pctx.fillStyle = '#000'
    pctx.fillRect(0, 0, W, H)
    await pollMeasure()
    measureTimer = window.setInterval(pollMeasure, 400)
  } else {
    if (prev === 'measure' && bridge) await rebuildPage(bridge, 'image', HINT).catch(() => {})
    resetTileCache()
    status('已回到画面模式')
  }
}
measureBtn.addEventListener('click', () => setView(view === 'measure' ? 'camera' : 'measure'))
planBtn.addEventListener('click', () => setView(view === 'plan' ? 'camera' : 'plan'))

// 调参数时：静态照片立刻重算
function onOptionChange() {
  $('sensVal').textContent = sens.value
  $('thickVal').textContent = thick.value
  $('brightVal').textContent = bright.value
  try { localStorage.setItem('brightness', bright.value) } catch {}
  if (view === 'camera' && !running && lastSource instanceof HTMLImageElement && !busy) processStill(lastSource)
}
sens.addEventListener('input', onOptionChange)
thick.addEventListener('input', onOptionChange)
bright.addEventListener('input', onOptionChange)

liveBtn.addEventListener('click', async () => {
  if (liveSource) return pauseToggle()
  status('连接手机相机…')
  if (!(await startLive()))
    status('请先打开手机上的「G2 桥接」App，按「③ 开始实时相机」，再回来按“开始实时”')
})
shotBtn.addEventListener('click', takeShot)

// ---------- 眼镜输入 ----------
function onGlassesInput(type: OsEventTypeList | undefined) {
  // 注意：单击事件的 eventType 可能是 undefined（protobuf 默认值 0 被省略）
  const t = type ?? OsEventTypeList.CLICK_EVENT
  switch (t) {
    case OsEventTypeList.CLICK_EVENT:
      if (view === 'measure') measureCmd('add')
      else if (view === 'plan') planCmd('add')
      else if (liveSource) pauseToggle()
      else
        bridgeCameraRunning().then((on) => {
          if (on) startLive()
          else takeShot()
        })
      break
    case OsEventTypeList.SCROLL_TOP_EVENT:
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: {
      if (view === 'measure') {
        measureCmd(t === OsEventTypeList.SCROLL_TOP_EVENT ? 'undo' : 'clear')
        break
      }
      if (view === 'plan') {
        planCmd(t === OsEventTypeList.SCROLL_TOP_EVENT ? 'undo' : 'zoom')
        break
      }
      // 照片模式：滑动调亮度；线条、素描：滑动调灵敏度
      const d = t === OsEventTypeList.SCROLL_TOP_EVENT ? 1 : -1
      const el = mode === 'photo' ? bright : sens
      el.value = String(Math.min(10, Math.max(1, +el.value + d)))
      onOptionChange()
      status((mode === 'photo' ? '亮度：' : '灵敏度：') + el.value)
      break
    }
    case OsEventTypeList.LONG_PRESS_EVENT:
      // 线条 → 素描 → 照片 → 测量 → 平面图 → 线条…
      if (view === 'measure') {
        setView('plan')
      } else if (view === 'plan') {
        setView('camera').then(() => setMode('lines'))
      } else if (mode === 'photo') {
        setView('measure')
      } else {
        setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])
        status('模式：' + MODE_NAME[mode])
      }
      break
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      stopLive()
      if (measureTimer) clearInterval(measureTimer)
      if (planTimer) clearInterval(planTimer)
      bridge?.shutDownPageContainer(1)
      break
  }
}

// ---------- 启动 ----------
async function init() {
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ])
  } catch {
    bridge = null
  }
  if (!bridge) {
    // 普通浏览器里也能测试画面（不送眼镜）
    status('浏览器测试模式（没连眼镜）：按“开始实时”')
    return
  }

  let ok = false
  try {
    ok = await createPage(bridge, HINT)
  } catch (e) {
    console.warn('createPage failed', e)
  }
  if (!ok) {
    bridge = null
    status('没连上眼镜（浏览器测试模式）：按“开始实时”')
    return
  }
  resetTileCache()
  bridge.onEvenHubEvent((e) => {
    if (e.textEvent) onGlassesInput(e.textEvent.eventType)
    else if (e.sysEvent) {
      const t = e.sysEvent.eventType
      if (t === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
        if (running && liveSource === 'webcam') pauseToggle()
      } else if (t !== OsEventTypeList.IMU_DATA_REPORT && t !== OsEventTypeList.LONG_PRESS_RELEASE_EVENT) onGlassesInput(t)
    }
  })
  status('已连接眼镜 · 按“开始实时”或单击镜腿')
  console.log('APP_READY')

  // 测试用：网址加 ?view=measure 直接进入测量模式
  const qv = new URLSearchParams(location.search).get('view')
  if (qv === 'measure' || qv === 'plan') await setView(qv)

  // 测试用：网址加 ?demo 会直接处理一张示范照片
  if (new URLSearchParams(location.search).has('demo')) {
    await processStill(await loadImage('./demo.jpg'))
    console.log('DEMO_SENT')
  }
}

setMode(mode)
init()

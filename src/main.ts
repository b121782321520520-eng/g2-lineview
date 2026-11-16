import { waitForEvenAppBridge, OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { detectEdges, rgbaToGray } from './edges'
import { W, H, createPage, sendFrame, resetTileCache } from './glasses'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('video')
const preview = $<HTMLCanvasElement>('preview')
const pctx = preview.getContext('2d')!
const statusEl = $('status')
const liveBtn = $<HTMLButtonElement>('live')
const shotBtn = $<HTMLButtonElement>('shot')
const sens = $<HTMLInputElement>('sens')
const thick = $<HTMLInputElement>('thick')

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

const options = () => ({ sensitivity: +sens.value, thickness: +thick.value })

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
  const mask = detectEdges(rgbaToGray(data, W, H), W, H, options())

  // 手机上的预览：绿线黑底，和眼镜看起来一样
  const out = pctx.createImageData(W, H)
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4
    out.data[p + 1] = mask[i] ? 255 : 0
    out.data[p + 3] = 255
  }
  pctx.putImageData(out, 0, 0)
  const t1 = performance.now()

  let sent = 0
  if (bridge) sent = await sendFrame(bridge, mask)
  const t2 = performance.now()
  return { proc: t1 - t0, send: t2 - t1, sent }
}

// ---------- 实时模式（getUserMedia） ----------
async function startLive(): Promise<boolean> {
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
  running = true
  lastSource = null
  liveBtn.textContent = '暂停'
  loop()
  return true
}

function stopLive() {
  running = false
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  liveBtn.textContent = '开始实时'
}

function pauseToggle() {
  if (!stream) return
  running = !running
  liveBtn.textContent = running ? '暂停' : '继续'
  if (running) loop()
  else status('已暂停（单击镜腿继续）')
}

async function loop() {
  while (running) {
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
    status(`已显示 · 处理 ${r.proc.toFixed(0)}ms，传送 ${r.send.toFixed(0)}ms`)
  } finally {
    busy = false
  }
}

async function takeShot() {
  if (busy) return
  if (stream) stopLive()
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

// 调参数时：静态照片立刻重算
function onOptionChange() {
  $('sensVal').textContent = sens.value
  $('thickVal').textContent = thick.value
  if (!running && lastSource instanceof HTMLImageElement && !busy) processStill(lastSource)
}
sens.addEventListener('input', onOptionChange)
thick.addEventListener('input', onOptionChange)

liveBtn.addEventListener('click', async () => {
  if (stream) return pauseToggle()
  status('请求摄像头…')
  if (!(await startLive())) status('这个环境不能实时拍摄，请改用“拍一张”')
})
shotBtn.addEventListener('click', takeShot)

// ---------- 眼镜输入 ----------
function onGlassesInput(type: OsEventTypeList | undefined) {
  // 注意：单击事件的 eventType 可能是 undefined（protobuf 默认值 0 被省略）
  const t = type ?? OsEventTypeList.CLICK_EVENT
  switch (t) {
    case OsEventTypeList.CLICK_EVENT:
      if (stream) pauseToggle()
      else if (lastSource === null) {
        startLive().then((ok) => {
          if (!ok) takeShot()
        })
      } else takeShot()
      break
    case OsEventTypeList.SCROLL_TOP_EVENT:
      sens.value = String(Math.min(10, +sens.value + 1))
      onOptionChange()
      break
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      sens.value = String(Math.max(1, +sens.value - 1))
      onOptionChange()
      break
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      stopLive()
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
    ok = await createPage(bridge, '线条视界\n\n单击镜腿：开始\n上滑 / 下滑：调灵敏度\n双击：退出')
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
        if (running) pauseToggle()
      } else if (t !== OsEventTypeList.IMU_DATA_REPORT) onGlassesInput(t)
    }
  })
  status('已连接眼镜 · 按“开始实时”或单击镜腿')
  console.log('APP_READY')

  // 测试用：网址加 ?demo 会直接处理一张示范照片
  if (new URLSearchParams(location.search).has('demo')) {
    await processStill(await loadImage('./demo.jpg'))
    console.log('DEMO_SENT')
  }
}

init()

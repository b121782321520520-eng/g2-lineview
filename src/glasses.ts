// 眼镜端：页面布局 + 把 576x288 的线条遮罩切成 4 块送出去
import {
  type EvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

export const W = 576
export const H = 288
const TW = 288 // 单个图片容器最大 288x144
const TH = 144

const TEXT_ID = 1
const TEXT_NAME = 'evt'
const TILES = [
  { id: 2, name: 'tile0', x: 0, y: 0 },
  { id: 3, name: 'tile1', x: TW, y: 0 },
  { id: 4, name: 'tile2', x: 0, y: TH },
  { id: 5, name: 'tile3', x: TW, y: TH },
]

function textProp(content: string) {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: W,
    height: H,
    borderWidth: 0,
    paddingLength: 8,
    containerID: TEXT_ID,
    containerName: TEXT_NAME,
    content,
    isEventCapture: 1,
    zOrderIndex: 0,
  })
}

function imageProps() {
  return TILES.map(
    (t, i) =>
      new ImageContainerProperty({
        xPosition: t.x,
        yPosition: t.y,
        width: TW,
        height: TH,
        containerID: t.id,
        containerName: t.name,
        zOrderIndex: i + 1,
      }),
  )
}

/** 切换页面：'image' = 文字底层＋4 块图片；'text' = 只有全屏文字（测量模式用） */
export async function rebuildPage(bridge: EvenAppBridge, kind: 'image' | 'text', content: string): Promise<boolean> {
  const images = kind === 'image' ? imageProps() : []
  const ok = await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 1 + images.length,
      textObject: [textProp(content)],
      imageObject: images,
    }),
  )
  resetTileCache()
  return ok
}

export async function createPage(bridge: EvenAppBridge, hint: string): Promise<boolean> {
  // 底层：全屏文字容器，负责接收镜腿/戒指的点击和滑动
  const text = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: W,
    height: H,
    borderWidth: 0,
    paddingLength: 8,
    containerID: TEXT_ID,
    containerName: TEXT_NAME,
    content: hint,
    isEventCapture: 1,
    zOrderIndex: 0,
  })
  // 上层：2x2 四个图片容器拼成整个画面
  const images = TILES.map(
    (t, i) =>
      new ImageContainerProperty({
        xPosition: t.x,
        yPosition: t.y,
        width: TW,
        height: TH,
        containerID: t.id,
        containerName: t.name,
        zOrderIndex: i + 1,
      }),
  )
  const res = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1 + images.length,
      textObject: [text],
      imageObject: images,
    }),
  )
  console.log('[glasses] createStartUpPageContainer ->', res)
  return res === 0
}

export async function setHint(bridge: EvenAppBridge, content: string) {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: TEXT_ID, containerName: TEXT_NAME, content }),
  )
}

// 每块上次送出的内容指纹，没变就不重送（省时间）
const lastHash: (number | null)[] = [null, null, null, null]
// 每块上次送出的画面（实时模式用来判断"变化够不够大"）
const lastTile: (Uint8Array | null)[] = [null, null, null, null]

export function resetTileCache() {
  lastHash.fill(null)
  lastTile.fill(null)
}

/** 这一块和上次送出的相比，有多少比例的像素明显不同 */
function tileChange(frame: Uint8Array, i: number): number {
  const prev = lastTile[i]
  if (!prev) return 1
  const t = TILES[i]
  let diff = 0
  for (let y = 0; y < TH; y++) {
    const row = (t.y + y) * W + t.x
    for (let x = 0; x < TW; x++) {
      if (Math.abs(frame[row + x] - prev[y * TW + x]) >= 2) diff++
    }
  }
  return diff / (TW * TH)
}

function copyTile(frame: Uint8Array, i: number): Uint8Array {
  const t = TILES[i]
  const out = new Uint8Array(TW * TH)
  for (let y = 0; y < TH; y++) out.set(frame.subarray((t.y + y) * W + t.x, (t.y + y) * W + t.x + TW), y * TW)
  return out
}

const tileCanvas = document.createElement('canvas')
tileCanvas.width = TW
tileCanvas.height = TH
const tileCtx = tileCanvas.getContext('2d')!

/** 把画面的一块编码成灰度 PNG（每个像素 0-15 级；0 在眼镜上就是不亮） */
async function encodeTile(frame: Uint8Array, ox: number, oy: number): Promise<{ png: number[]; hash: number }> {
  const img = tileCtx.createImageData(TW, TH)
  let hash = 2166136261
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      const lv = frame[(oy + y) * W + (ox + x)]
      const v = lv * 17
      const p = (y * TW + x) * 4
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v
      img.data[p + 3] = 255
      hash = Math.imul(hash ^ lv, 16777619)
    }
  }
  tileCtx.putImageData(img, 0, 0)
  const blob: Blob = await new Promise((r) => tileCanvas.toBlob((b) => r(b!), 'image/png'))
  const png = Array.from(new Uint8Array(await blob.arrayBuffer()))
  return { png, hash: hash >>> 0 }
}

export interface TileLog {
  tile: number
  ms: number
  bytes: number
  result: string
}

/** 送一整帧到眼镜。图片必须一张一张送（不能并发）。返回每一块的记录 */
export async function sendFrame(bridge: EvenAppBridge, frame: Uint8Array, minChange = 0): Promise<TileLog[]> {
  const logs: TileLog[] = []
  for (let i = 0; i < TILES.length; i++) {
    const t = TILES[i]
    // 实时模式：变化太小（只是噪点、轻微晃动）就不重送
    if (minChange > 0 && tileChange(frame, i) < minChange) continue
    const { png, hash } = await encodeTile(frame, t.x, t.y)
    if (lastHash[i] === hash) continue
    const t0 = performance.now()
    let result = ''
    try {
      const res = await bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: t.id, containerName: t.name, imageData: png }),
      )
      const norm = ImageRawDataUpdateResult.normalize(res)
      result = String(norm)
      if (ImageRawDataUpdateResult.isSuccess(norm)) {
        lastHash[i] = hash
        lastTile[i] = copyTile(frame, i)
      }
    } catch (e) {
      result = 'error: ' + e
    }
    const log = { tile: i, ms: Math.round(performance.now() - t0), bytes: png.length, result }
    console.log('[glasses] tile', log)
    logs.push(log)
  }
  return logs
}

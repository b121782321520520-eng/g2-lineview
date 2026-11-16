// 眼镜端：页面布局 + 把 576x288 的线条遮罩切成 4 块送出去
import {
  type EvenAppBridge,
  CreateStartUpPageContainer,
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

export function resetTileCache() {
  lastHash.fill(null)
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

/** 送一整帧到眼镜。图片必须一张一张送（不能并发）。返回实际送出的块数 */
export async function sendFrame(bridge: EvenAppBridge, frame: Uint8Array): Promise<number> {
  let sent = 0
  for (let i = 0; i < TILES.length; i++) {
    const t = TILES[i]
    const { png, hash } = await encodeTile(frame, t.x, t.y)
    if (lastHash[i] === hash) continue
    const res = await bridge.updateImageRawData(
      new ImageRawDataUpdate({ containerID: t.id, containerName: t.name, imageData: png }),
    )
    if (ImageRawDataUpdateResult.isSuccess(ImageRawDataUpdateResult.normalize(res))) {
      lastHash[i] = hash
      sent++
    } else {
      console.warn('[glasses] tile', i, 'failed:', res)
    }
  }
  return sent
}

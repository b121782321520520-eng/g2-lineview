// 把灰度照片变成眼镜画面（每个像素 0-15 亮度级）
import { detectEdges } from './edges'

export type Mode = 'lines' | 'sketch' | 'photo'

export interface RenderOptions {
  mode: Mode
  sensitivity: number // 1-10
  thickness: number // 0-2
}

/** 去掉面积太小的零碎线段（8 连通） */
export function removeSmallSegments(mask: Uint8Array, w: number, h: number, minSize: number): Uint8Array {
  const out = new Uint8Array(mask)
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const comp: number[] = []
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || seen[i]) continue
    comp.length = 0
    stack.push(i)
    seen[i] = 1
    while (stack.length) {
      const c = stack.pop()!
      comp.push(c)
      const cx = c % w
      const cy = (c / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (out[j] && !seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        }
      }
    }
    if (comp.length < minSize) for (const c of comp) out[c] = 0
  }
  return out
}

/** 亮度拉伸：取第 2% 和第 98% 的亮度当黑白点，让画面对比更好 */
function stretch(gray: Float32Array): Float32Array {
  const hist = new Uint32Array(256)
  for (const v of gray) hist[Math.max(0, Math.min(255, v | 0))]++
  const n = gray.length
  let acc = 0
  let lo = 0
  let hi = 255
  for (let i = 0; i < 256; i++) {
    acc += hist[i]
    if (acc >= n * 0.02) { lo = i; break }
  }
  acc = 0
  for (let i = 255; i >= 0; i--) {
    acc += hist[i]
    if (acc >= n * 0.02) { hi = i; break }
  }
  const range = Math.max(1, hi - lo)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(1, (gray[i] - lo) / range))
  return out
}

/** 平滑量化（不抖色）：同色区块连成一片，传输时压缩率高很多 */
function quantize(v: Float32Array, maxLevel: number): Uint8Array {
  const out = new Uint8Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = Math.round(Math.max(0, Math.min(1, v[i])) * maxLevel)
  return out
}

/** 降成 1/f 分辨率（区块平均）再放大回来：相邻像素相同，蓝牙传输量大减 */
function blocky(v: Float32Array, w: number, h: number, f: number): Float32Array {
  const out = new Float32Array(v.length)
  for (let by = 0; by < h; by += f) {
    for (let bx = 0; bx < w; bx += f) {
      let s = 0
      let n = 0
      for (let y = by; y < Math.min(h, by + f); y++)
        for (let x = bx; x < Math.min(w, bx + f); x++) { s += v[y * w + x]; n++ }
      const a = s / n
      for (let y = by; y < Math.min(h, by + f); y++)
        for (let x = bx; x < Math.min(w, bx + f); x++) out[y * w + x] = a
    }
  }
  return out
}

/** 量化成 steps 种亮度，最亮对应 maxLevel 级 */
function posterize(v: Float32Array, steps: number, maxLevel: number): Uint8Array {
  const out = new Uint8Array(v.length)
  for (let i = 0; i < v.length; i++) {
    const q = Math.round(Math.max(0, Math.min(1, v[i])) * (steps - 1)) / (steps - 1)
    out[i] = Math.round(q * maxLevel)
  }
  return out
}

/** 轻微模糊，去掉噪点，让色块更平整 */
function smooth(v: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(v.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          s += v[yy * w + xx]
          n++
        }
      }
      out[y * w + x] = s / n
    }
  }
  return out
}

/** Floyd–Steinberg 抖色到 levels 阶，maxLevel 为最亮的级数（目前未使用，保留） */
export function dither(v: Float32Array, w: number, h: number, maxLevel: number): Uint8Array {
  const buf = new Float32Array(v)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const old = Math.max(0, Math.min(1, buf[i])) * maxLevel
      const q = Math.round(old)
      out[i] = q
      const err = (old - q) / maxLevel
      if (x + 1 < w) buf[i + 1] += (err * 7) / 16
      if (y + 1 < h) {
        if (x > 0) buf[i + w - 1] += (err * 3) / 16
        buf[i + w] += (err * 5) / 16
        if (x + 1 < w) buf[i + w + 1] += err / 16
      }
    }
  }
  return out
}

export function render(gray: Float32Array, w: number, h: number, opt: RenderOptions): Uint8Array {
  const out = new Uint8Array(w * h)

  if (opt.mode === 'photo') {
    // 照片：16 阶灰度。稍微压暗（gamma），眼镜上亮的地方会挡视线
    // 最亮只到 12 级，避免窗户、白墙整片刺眼挡视线
    // 蓝牙每秒只能传约 10KB：用半分辨率＋8 种亮度，一张约 10KB ≈ 1 秒
    const s = blocky(stretch(gray), w, h, 2)
    for (let i = 0; i < s.length; i++) s[i] = Math.pow(s[i], 1.4)
    return posterize(s, 8, 12)
  }

  let edges = detectEdges(gray, w, h, { sensitivity: opt.sensitivity, thickness: 0 })
  edges = removeSmallSegments(edges, w, h, 12 + (10 - opt.sensitivity) * 3)
  if (opt.thickness > 0) edges = thicken(edges, w, h, opt.thickness)

  if (opt.mode === 'sketch') {
    // 素描：淡淡的明暗（最亮只到 5 级）＋最亮的轮廓线
    // 明暗用半分辨率、6 种亮度（最亮 5 级）；轮廓线保持全分辨率
    const s = blocky(stretch(gray), w, h, 2)
    const shade = posterize(s, 6, 5)
    for (let i = 0; i < out.length; i++) out[i] = edges[i] ? 15 : shade[i]
    return out
  }

  for (let i = 0; i < out.length; i++) out[i] = edges[i] ? 15 : 0
  return out
}

function thicken(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < w) out[yy * w + xx] = 1
        }
      }
    }
  }
  return out
}

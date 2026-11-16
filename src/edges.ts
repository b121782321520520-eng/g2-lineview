// Canny 边缘检测（纯 TypeScript，无依赖）
// 输入：灰度图 (0-255)，输出：线条遮罩 (1 = 线条, 0 = 空白)

export interface EdgeOptions {
  /** 灵敏度 1-10，越大线条越多 */
  sensitivity: number
  /** 线条加粗像素（0 = 1px 细线） */
  thickness: number
}

export function rgbaToGray(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h)
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
  }
  return g
}

/** 5x5 高斯模糊（可分离），去掉噪点 */
function blur(src: Float32Array, w: number, h: number): Float32Array {
  const k = [1, 4, 6, 4, 1]
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -2; i <= 2; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i))
        s += src[y * w + xx] * k[i + 2]
      }
      tmp[y * w + x] = s / 16
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -2; i <= 2; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i))
        s += tmp[yy * w + x] * k[i + 2]
      }
      out[y * w + x] = s / 16
    }
  }
  return out
}

export function detectEdges(gray: Float32Array, w: number, h: number, opt: EdgeOptions): Uint8Array {
  const g = blur(gray, w, h)
  const n = w * h
  const mag = new Float32Array(n)
  const dir = new Uint8Array(n) // 0:水平 1:45° 2:垂直 3:135°

  // Sobel 梯度
  let maxMag = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx =
        -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] +
        g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]
      const gy =
        -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] +
        g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]
      const m = Math.hypot(gx, gy)
      mag[i] = m
      if (m > maxMag) maxMag = m
      let a = (Math.atan2(gy, gx) * 180) / Math.PI
      if (a < 0) a += 180
      dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3
    }
  }

  // 非极大值抑制：只保留最细的那条线
  const nms = new Float32Array(n)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const m = mag[i]
      let a: number, b: number
      switch (dir[i]) {
        case 0: a = mag[i - 1]; b = mag[i + 1]; break
        case 1: a = mag[i - w + 1]; b = mag[i + w - 1]; break
        case 2: a = mag[i - w]; b = mag[i + w]; break
        default: a = mag[i - w - 1]; b = mag[i + w + 1]
      }
      if (m >= a && m >= b) nms[i] = m
    }
  }

  // 自适应阈值：灵敏度越高，阈值越低
  const s = Math.min(10, Math.max(1, opt.sensitivity))
  const high = maxMag * (0.42 - s * 0.035) // s=1 → 0.385, s=10 → 0.07
  const low = high * 0.4

  // 双阈值 + 连接（hysteresis）
  const out = new Uint8Array(n)
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (nms[i] >= high && !out[i]) {
      out[i] = 1
      stack.push(i)
      while (stack.length) {
        const c = stack.pop()!
        const cx = c % w
        const cy = (c / w) | 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            const j = ny * w + nx
            if (!out[j] && nms[j] >= low) {
              out[j] = 1
              stack.push(j)
            }
          }
        }
      }
    }
  }

  return opt.thickness > 0 ? dilate(out, w, h, opt.thickness) : out
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          out[yy * w + xx] = 1
        }
      }
    }
  }
  return out
}

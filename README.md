# G2 线条视界（g2-lineview）

用手机摄像头拍下眼前的景象，在手机上转成线条图（Canny 边缘检测），再送到 Even Realities G2 眼镜上显示。

## 两种模式
- **实时**：手机摄像头连续取景，每 1～2 秒更新一次眼镜画面。用的是浏览器的 `getUserMedia`，需要 Even App 的 WebView 允许才能用。
- **拍一张**：调用 Even App 自带的相机（`captureImageFromCamera`）拍照后转成线条图。实时模式不能用时，就用这个。

## 眼镜操作
| 操作 | 作用 |
|---|---|
| 单击镜腿 / 戒指 | 开始；实时中＝暂停 / 继续 |
| 上滑 / 下滑 | 线条灵敏度 +1 / -1（1～10） |
| 双击 | 退出 |

## 在电脑上跑
```bash
npm install
npm run dev                     # 开发服务器，http://localhost:5173
npx evenhub-simulator "http://localhost:5173/?demo"   # 模拟器，?demo 会自动显示示范照片
```

## 装到真的眼镜上
**方法 A：开发时扫码（手机和电脑连同一个 Wi-Fi）**
```bash
npm run dev
npx evenhub qr --url http://<电脑的IP>:5173
```
用 Even App 扫二维码。

**方法 B：安装包**
`npm run pack` 会生成 `g2-lineview.ehpk`，再用 `evenhub upload` 上传到 Even Hub（可以只给自己当测试者）。

## 技术说明
- 画面 576×288 被拆成 2×2 四个 288×144 的图片容器（SDK 规定单个容器最大 288×144）。
- 每块编码成 PNG（白线黑底），由 Even App 转成 4-bit 灰度。黑色在眼镜上就是不亮。
- 某一块画面没变时不会重送，可以省传输时间。
- 边缘检测是纯 TypeScript（`src/edges.ts`），不依赖 OpenCV。

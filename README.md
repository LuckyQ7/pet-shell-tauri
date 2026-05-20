# Pet Shell Tauri

A minimal Windows and macOS desktop-pet shell for Codex pet assets.

## What It Does

- Opens a frameless transparent always-on-top pet window.
- Loads `public/pets/taro/pet.json` and `spritesheet.webp`.
- Plays Codex-style `192x208` sprite cells across 9 animation rows.
- Supports dragging the pet window.
- Shows a small hover menu and right-click menu for state switching.
- Installs additional Codex-compatible pet resource folders from the right-click menu.

## 关键配置说明

`src-tauri/tauri.conf.json` 是标准 JSON，不能直接写注释。几个关键字段的含义：

- `decorations: false`：隐藏系统标题栏和边框。
- `transparent: true`：允许窗口透明。
- `alwaysOnTop: true`：让桌宠浮在普通窗口上方。
- `skipTaskbar: true`：不在任务栏/Dock 中常驻显示。
- `backgroundColor: "#00000000"`：窗口背景透明。
- `macOSPrivateApi: true`：macOS 透明窗口需要这个能力。
- `devUrl: "http://127.0.0.1:1420"`：Tauri 开发模式连接的 Vite 地址。

前端注释主要在 `src/main.js`：那里负责读取宠物配置、切 spritesheet 帧、切换状态、拖动窗口和右键菜单。

## 安装宠物资源包

右键桌宠，选择 `安装宠物资源包...`，然后选择一个包含以下文件的目录：

```text
pet.json
spritesheet.webp
```

安装后资源会复制到应用数据目录的 `pets/<pet-id>/` 下，并立即切换到新宠物。再次右键可以在已安装宠物之间切换。

## Run

```bash
pnpm install
pnpm tauri:dev
```

## Build

```bash
pnpm tauri:build
```

## Windows 打包

项目包含 GitHub Actions workflow：

```text
.github/workflows/build-windows.yml
```

推到 GitHub 后，可以在仓库的 `Actions -> Build Windows App -> Run workflow` 手动运行。运行完成后，在 workflow 页面下载 `pet-shell-tauri-windows` artifact，里面会包含 Windows 安装包：

```text
src-tauri/target/release/bundle/msi/*.msi
src-tauri/target/release/bundle/nsis/*.exe
```

也可以推送 `v*` tag 自动触发：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Swap Pet

Replace these files with another Codex-compatible pet:

```text
public/pets/taro/pet.json
public/pets/taro/spritesheet.webp
```

The shell currently assumes the standard Codex pet atlas:

```text
cell: 192x208
columns: 8
rows:
0 idle
1 running-right
2 running-left
3 waving
4 jumping
5 failed
6 waiting
7 running
8 review
```

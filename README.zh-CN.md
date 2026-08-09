# office-3d — Hermes 桌面端的实时等距办公室

一个 Hermes 桌面插件，把你的 Hermes **各个 profile 渲染成等距（isometric）办公室里的小人**。每个 profile 有自己的工位：真正在干活时坐在工位敲键盘、显示器亮着绿色代码；在线但空闲时到休息区喝茶 🍵；离线时工位空着、显示器熄灭。底部有一条状态栏，聚合显示所有 profile 的活跃会话数、token 数、成本。

[English](./README.md) | 中文

## 截图

![office-3d 截图](./docs/screenshot.jpeg)
![office-3d 截图](./docs/screenshot-2.jpeg)

## 展示内容

| 状态 | 含义 | 办公室里的表现 |
|---|---|---|
| **busy（忙）** | 该 profile 最近约 90 秒内有活跃会话（真在干活）| 小人在工位敲键盘、屏幕跳绿色代码 |
| **idle（空闲在线）** | 在线但近期无会话活动 | 小人在休息区端着茶 🍵 |
| **offline（离线）** | 无存活进程 / 无近期活动 | 空工位、显示器熄灭、名字变暗 |

- 自动跟随 Hermes 的明暗主题。
- 底部状态徽章：**online / busy / 活跃会话 / tokens / agents / cost**，跨所有 profile 聚合。
- 后端只读各 profile `state.db` 的聚合列（COUNT/SUM/MAX），**绝不读会话正文**。

## 技术栈

- **@hermes/plugin-sdk** — Hermes 桌面插件 API（单文件 ESM，无需构建）
- **Canvas 2D** — 手写等距（isometric）投影（不用 WebGL / three.js）
- **React**（经 SDK 的 jsx runtime）— `useQuery` 轮询 + canvas 生命周期管理
- **Python + FastAPI** — 只读的 dashboard 后端，挂载于 `/api/plugins/office-3d/`
- **SQLite**（只读，仅标准库）— 各 profile 的会话 / token / 成本聚合

## 工作原理

三个部分（对应 Hermes 桌面插件的三层）：

1. **前端** — `desktop-plugins/office-3d/plugin.js` — 桌面 app 运行时加载的单个 ESM 文件（canvas 2D 等距场景，无需编译）。
2. **后端** — `plugins/office-3d/dashboard/plugin_api.py` + `manifest.json` — 一个 FastAPI 路由，由 dashboard web 服务挂载到 `/api/plugins/office-3d/state`。它扫描每个 profile 的 `gateway_state.json`（进程存活）和 `state.db`（会话活动 + token/成本聚合）。
3. **启用开关** — 后端被 import 前，`office-3d` 必须出现在 `config.yaml` 的 `plugins.enabled` 里（安全门）。

插件可移植：`HERMES_HOME` 会优先读环境变量 `$HERMES_HOME`（回退 `~/.hermes`），profile 通过扫描 `~/.hermes/profiles/` 动态发现——**不写死任何 profile 名字**。

## 安装

### 快速安装（脚本）

```bash
git clone https://github.com/oslook/hermes-desktop-plugin-office-3d.git
cd hermes-desktop-plugin-office-3d
bash install.sh
```

脚本会把文件复制到你的 Hermes home、启用后端，并提示如何重载。

### 手动安装

```bash
# 1. 前端
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/office-3d"
cp desktop-plugins/office-3d/plugin.js "${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/office-3d/"

# 2. 后端
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins/office-3d/dashboard"
cp plugins/office-3d/dashboard/plugin_api.py plugins/office-3d/dashboard/manifest.json \
   "${HERMES_HOME:-$HOME/.hermes}/plugins/office-3d/dashboard/"

# 3. 启用后端（会往 config.yaml 写入真正的 YAML 列表）
hermes plugins enable office-3d
```

然后让它生效：

- **前端**：彻底退出并重开 Hermes 桌面 app（或 ⌘K → **Reload desktop plugins**），再从侧栏打开 **Office** 页面。
- **后端**：重启 dashboard web 服务，让它挂载 `/api/plugins/office-3d/`。如果你用 `hermes dashboard`，停掉再启动即可。（若是 LAN/LaunchAgent 部署，重启对应服务。）

## 前置要求

- Hermes Desktop **0.17.0+** —— 必须有桌面 app；只有 CLI/gateway 不会加载桌面插件。（在 0.20.0 上开发，向下测到 0.17.0。）
- dashboard web 服务在运行（它才提供 `/api/plugins/...`）。

## 卸载

```bash
hermes plugins disable office-3d
rm -rf "${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/office-3d"
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/office-3d"
```
然后重载桌面插件 / 重启 dashboard。

## 隐私说明

后端以**只读**方式打开每个 profile 的 `state.db`，只对 `sessions` 表跑聚合查询（COUNT/SUM/MAX）——会话数、token 合计、成本、最近活动时间。**不读取消息正文、system prompt 或标题**。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
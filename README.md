# 69shuba 小说下载器（命令行版）

用真实浏览器内核（Playwright/Chromium）绕过 Cloudflare，限速 + 断点续传。
已对两个站点实测跑通，正文干净、无乱码：
- `https://69shuba.tw/indexlist/390809/`（288 章）
- `https://www.69shuba.com/book/58851/`（696 章）

## 网站结构（已验证，自动适配）

| | 69shuba.tw | www.69shuba.com |
|---|---|---|
| 目录页 | `/indexlist/<id>/<页>/`，"下一页"翻页 | `/book/<id>/`，单页列全部章节 |
| 章节链接 | `/read/<id>/<章节id>` | `/txt/<id>/<章节id>` |
| 正文容器 | `#nr1` | `.txtnav` |
| CF 形态 | 偶发 `403 token invalid` | "请稍候…" JS 质询 |

脚本会从传入的目录页 URL 自动识别站点形态、书籍 ID、章节链接样式与正文容器，无需手动指定。风控统一处理：JS 质询自动等待解算，硬拦截指数退避重试。

## 安装

```powershell
cd D:\Code\Claude\69shuba-downloader
npm init -y
npm i playwright
npx playwright install chromium
```

## 用法

```powershell
node download.js <目录页URL> [选项]
```

| 选项 | 说明 |
|---|---|
| `-u, --url <url>` | 目录页链接（也可作为第一个位置参数传入） |
| `-s, --start <n>` | 从第 n 章开始下载（默认 1） |
| `-e, --end <n>`   | 下载到第 n 章为止（默认最后一章） |
| `--no-headless`   | 显示 Chrome 窗口（**默认隐藏后台运行**；手动过验证时加此项） |
| `--min <ms>`      | 每章最小间隔毫秒（默认 8000） |
| `--max <ms>`      | 每章最大间隔毫秒（默认 15000） |
| `-o, --out <dir>` | 输出目录（默认 `./book_<id>`） |
| `-h, --help`      | 显示帮助 |

### 示例

```powershell
# 抓整本（默认隐藏窗口后台跑，间隔 8000~15000ms）
node download.js https://69shuba.tw/indexlist/390809/

# 从第 88 章续抓
node download.js https://69shuba.tw/indexlist/390809/ --start 88

# 首跑想看窗口手动过验证：加 --no-headless
node download.js https://69shuba.tw/indexlist/390809/ --no-headless

# 只抓 50~120 章，放慢节奏更稳
node download.js https://69shuba.tw/indexlist/390809/ -s 50 -e 120 --min 15000 --max 40000

# 换一本书 / 换站点，只要把目录页 URL 换掉即可（站点形态与书 ID 自动识别）
node download.js https://69shuba.tw/indexlist/123456/
node download.js https://www.69shuba.com/book/58851/
```

> 默认隐藏窗口后台运行。若首跑遇到过不去的人机验证，加 `--no-headless` 在窗口里手动点一下（cookie 会存进 `book_<id>/profile/` 复用），之后再用默认模式后台跑。

## 产物

- `book_<id>/chapters/0001.txt ...` 每章单独存（断点续传依据）
- `book_<id>/book_<id>.txt` 合并成品（每次运行结束按已有章节文件自动重建）
- `book_<id>/profile/` 浏览器用户数据（保存 cf_clearance）
- `book_<id>/chapters.json` 目录缓存（想重抓目录就删掉它）

## 在 GitHub Actions 云端运行（手机浏览器即可操作）

无需本机开机，手机网页就能触发、后台跑、跑完下载 txt。

### 一次性准备：推送到 GitHub

```bash
cd D:\Code\Claude\69shuba-downloader
git init
git add .
git commit -m "69shuba downloader"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

> 用**公开仓库**：GitHub Actions 分钟数不限、完全免费。`book_*/`、`node_modules/` 已被 `.gitignore` 忽略，不会误传。

### 用手机运行

1. 手机浏览器打开你的仓库 → **Actions** 标签
2. 左侧选 **“下载小说”** → 右侧 **Run workflow**
3. 填 `url`（目录页链接）、`start`/`end`（章节范围，可留默认）、`min`/`max`（间隔）→ 点绿色 **Run workflow**
4. 关掉浏览器即可，后台跑。跑完点进那次运行，页面底部 **Artifacts → novel-txt** 下载（zip 内含整本 txt）

### 云端注意事项 ⚠️

- **机房 IP 的 Cloudflare 比家庭宽带严**。GitHub 跑在 Azure 机房，CF 可能弹更难的验证甚至 403——而无头环境**无法手动点验证**。所以工作流已用 **xvfb + headful**（带界面的 Chromium，过 CF 成功率更高）。
- **务必先小范围试跑**：第一次把 `end` 设成 `3`，确认机房 IP 能过 CF，再整本跑。
- **单任务上限 6h**：长篇可能跑不完。工作流用了 `actions/cache` 缓存进度，**超时后再点一次 Run workflow（相同 url）即可从断点续抓**；或分段用 `start`/`end` 跑。
- 若机房 IP 始终过不去 CF，就回退到本机运行，或换 Google Colab / 自己的 VPS。

## 排错

- **被风控/拦截**：自动退避（1→2→…最多 10 分钟）。长时间过不去就加 `--no-headless` 在窗口里手动点验证后重跑。
- **中断恢复**：重跑同一命令即可，已下载章节自动跳过。
- **换站点抓不到目录**：`node debug.js` 打印目录页真实结构，对照调整 `download.js` 里的选择器/正则。
- 仅供个人离线阅读，请遵守网站条款与版权。

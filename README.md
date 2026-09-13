# Bilidown Web

Bilidown 是一个 Bilibili 视频下载工具的 Web 前端。本项目提供配套的 Cloudflare Workers API 代理，用于解决前端跨域请求和 WBI 签名问题。

## 项目结构

```
bilidown-web/
├── worker.js          # Cloudflare Workers API 代理脚本（部署到 CF Workers）
├── index.html         # 前端主页面（部署到静态托管）
├── css/
│   └── style.css      # 响应式样式
├── js/
│   ├── parser.js      # B站链接解析器
│   ├── api.js         # API 请求封装
│   └── app.js         # 主逻辑
└── README.md          # 本部署说明文档
```

> **重要**：`worker.js` 是本项目的 API 代理后端，必须部署到 Cloudflare Workers 供前端调用。前端（`index.html` + `css/` + `js/`）是纯静态页面，部署到 GitHub Pages 等托管平台。两者缺一不可 —— 前端依赖 Worker 提供的 `/api/parse`、`/api/image` 等接口。

## 前端部署到 GitHub Pages

### 前提条件

- 一个 GitHub 账号
- Git 已安装并配置

### 步骤

1. **创建 GitHub 仓库**

   登录 GitHub，点击右上角 "+" -> "New repository"，仓库名例如 `bilidown-web`，选择公开 (Public)。

2. **初始化本地项目并推送**

   ```bash
   cd /path/to/bilidown-web
   git init
   git add .
   git commit -m "初始化 Bilidown Web 项目"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/bilidown-web.git
   git push -u origin main
   ```

3. **启用 GitHub Pages**

   - 进入仓库页面，点击 "Settings"
   - 左侧菜单选择 "Pages"
   - "Source" 选择 "Deploy from a branch"
   - "Branch" 选择 `main`，文件夹选择 `/ (root)`
   - 点击 "Save"
   - 等待几分钟，GitHub Pages 会提供访问地址: `https://<你的用户名>.github.io/bilidown-web/`

4. **(可选) 使用自定义域名**

   在 GitHub Pages 设置页面的 "Custom domain" 中输入你的域名，并在 DNS 解析中添加对应的 CNAME 记录。

## Cloudflare Workers 部署

### 步骤 1: 注册 Cloudflare 账号

访问 [https://dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) 注册账号。如果已有账号，直接登录。

### 步骤 2: 创建 Worker

1. 登录 Cloudflare Dashboard: [https://dash.cloudflare.com/](https://dash.cloudflare.com/)
2. 在左侧菜单中选择 "Workers & Pages"
3. 点击 "Create application" 按钮
4. 选择 "Create Worker" 选项卡
5. 为 Worker 命名，例如 `bilidown-api`
6. 点击 "Deploy" 按钮

### 步骤 3: 粘贴 worker.js 代码

1. 在 Worker 创建成功后，点击 "Edit code" 进入代码编辑器
2. 删除编辑器中的默认代码
3. 打开本地的 `worker.js` 文件，全选复制所有内容
4. 粘贴到 Cloudflare 代码编辑器中
5. 点击 "Save and Deploy" 按钮

### 步骤 4: (可选) 配置 BILI_SESSDATA 环境变量

配置登录态的 `SESSDATA` 可以提高 API 请求的可用性，获取更高清晰度视频地址需要登录态。

#### 获取 SESSDATA

1. 打开浏览器，登录 [bilibili.com](https://www.bilibili.com)
2. 按 F12 打开开发者工具
3. 切换到 "Application" (Chrome) 或 "Storage" (Firefox) 选项卡
4. 在左侧找到 "Cookies" -> "https://www.bilibili.com"
5. 找到名为 `SESSDATA` 的 Cookie，复制其值

#### 配置环境变量

1. 在 Worker 详情页面，点击 "Settings" 选项卡
2. 找到 "Variables" 部分
3. 点击 "Add variable"
4. 变量名称: `BILI_SESSDATA`
5. 变量值: 粘贴刚才复制的 SESSDATA 值
6. (推荐) 勾选 "Encrypt" 以加密存储
7. 点击 "Save"

> **注意**: SESSDATA 会过期，需要定期更新。建议每次重新登录 B 站后更新此变量。

### 步骤 5: 校验部署

部署完成后，访问以下 URL 验证 Worker 是否正常运行:

```
https://bilidown-api.<你的子域名>.workers.dev/api/ping
```

正常返回:

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "status": "pong"
  }
}
```

### 步骤 6: (可选) 绑定自定义域名

1. 在 Worker 详情页，点击 "Triggers" 选项卡
2. 在 "Custom Domains" 区域，点击 "Add Custom Domain"
3. 输入你的域名 (例如 `api.bilidown.example.com`)
4. 按照指引在 DNS 提供商处添加对应的 CNAME 记录

## 配置前端 Worker URL

在 Bilidown 页面中完成配置，无需改代码：

1. 打开前端页面
2. 点击右上角**设置齿轮** ⚙️
3. 在"API 地址"输入框填入你的 Worker 地址，例如：

   ```
   https://bilidown-api.<你的子域名>.workers.dev
   ```

4. 点击"保存"

配置会存储到浏览器 localStorage（键名为 `bilidown_api_url`）。也可以在前端 `js/api.js` 顶部的 `API.setApiUrl()` 或通过控制台执行 `API.setApiUrl('https://...')` 手动设置。

> **注意**：`api.js` 与 `app.js` 的配置弹窗读写的是同一个键 `bilidown_api_url`，保存后在当前浏览器立即生效。生产环境建议前置 `https` 以提高可用性。

## API 路由一览

| 前端路径 | 方法 | B站 API | 说明 |
|---------|------|---------|------|
| `/api/ping` | GET | - | 连通性测试 |
| `/api/image?url=xxx` | GET | - | 图片代理（绕过 B站防盗链） |
| `/api/parse` | POST | - | 解析链接，返回视频/番剧信息 |
| `/api/video/info?bvid=xxx` | GET | `/x/web-interface/view` | 视频信息 (WBI) |
| `/api/video/playurl?bvid=xxx&cid=xxx` | GET | `/x/player/wbi/playurl` | 播放地址 (WBI) |
| `/api/popular?pn=1&ps=30` | GET | `/x/web-interface/popular` | 热门视频 (WBI) |
| `/api/season/info?epid=xxx` | GET | `/pgc/view/web/season` | 番剧信息 |
| `/api/search?keyword=xxx` | GET | `/x/web-interface/search/type` | 搜索 (WBI) |
| `/api/resolve` | POST | - | 短链接解析并返回信息 |
| `/api/download?bvid=xxx&cid=xxx` | GET | `/x/player/wbi/playurl` | 下载地址 (高清) |
| `/api/fav/list?id=xxx` | GET | `/x/v3/fav/resource/list` | 收藏夹内容 (WBI) |

## 使用说明

### 解析链接

向 `/api/parse` 发送 POST 请求，`body` 为 JSON 格式:

```json
{
  "url": "https://www.bilibili.com/video/BV1GJ411x7wF"
}
```

支持的输入格式:

- **BV 号**: `BV1GJ411x7wF`
- **AV 号**: `av170001` 或 `170001`
- **EP 号**: `ep123456`
- **SS 号**: `ss123456`
- **完整视频链接**: `https://www.bilibili.com/video/BV1GJ411x7wF`
- **番剧链接**: `https://www.bilibili.com/bangumi/play/ep123456`
- **短链接**: `https://b23.tv/xxxxx`
- **标题+链接**: `【我的视频】https://b23.tv/xxxxx`

### 获取播放地址

```bash
curl "https://bilidown-api.<你的子域名>.workers.dev/api/video/playurl?bvid=BV1GJ411x7wF&cid=123456"
```

### 搜索

```bash
curl "https://bilidown-api.<你的子域名>.workers.dev/api/search?keyword=间谍过家家"
```

## 常见问题

### Worker 返回 500 错误

检查 Worker 的日志:
1. 进入 Worker 详情页
2. 点击 "Logs" 选项卡
3. 查看最近的错误日志

### 获取视频信息返回 "账号未登录"

如果没有配置 `BILI_SESSDATA`，部分接口会返回 `-101` 错误。这通常不影响基础功能，但获取高清晰度视频地址时需要登录态。建议按上述步骤配置 `BILI_SESSDATA`。

### WBI 签名失败

WBI 签名从 `https://api.bilibili.com/x/web-interface/nav` 获取实时 key。如果此接口被墙或超时，会导致签名失败。确保 Worker 运行环境可以正常访问 `api.bilibili.com`。

### 跨域问题

Worker 已在所有响应中添加 `Access-Control-Allow-Origin: *` 头。如果仍有跨域问题，检查前端请求是否发送了需要预检的复杂请求 (如自定义 Header)，Worker 也已处理 OPTIONS 预检请求。

## License

MIT
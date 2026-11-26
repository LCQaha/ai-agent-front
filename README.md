# AI Agent Front

从后端静态页面抽出的独立 Vue 3 + Vite 项目。在聊天页的「当前应用」选择 **FirstApp**，可用完整回复或 SSE 连续对话。**LoveApp** 保留原有的完整回复入口。

## BaseChat Benchmark

启动监听 `8090` 的 Spring Boot 后端和前端开发服务器后，在工作台打开 **BaseChat Benchmark**。编辑测试输入并运行一次，页面会显示本次模型回答和浏览器测得的请求往返耗时。每次运行都是独立的单轮请求。

在输入框下方选择回复方式，再点击 **运行测试**。**完整回复** 使用普通 JSON 接口。**纯文本流** 通过 `POST /api/ai/benchmark-stream` 逐段显示正文。**事件流（SSE）** 通过 `POST /api/ai/benchmark-event-stream` 接收阶段通知和正文片段。两种流式模式都记录首段正文耗时。

事件流中，`turn.started` 和 `generation.started` 更新页面状态，`answer.delta` 将 `data.text` 追加到回答。收到 `turn.finished` 时，页面根据 `data.status` 显示完成或失败。如果连接提前关闭，页面提示缺少结束事件，并保留已经收到的正文。

前端向 `POST /api/ai/benchmark` 发送 `{"message":"请用一句话解释幂等。"}`。Vite 开发代理将它转发到 `http://localhost:8090/ai/benchmark`。使用本地 mock 联调时，让该路由返回 `{"message":"多次执行同一操作，效果与执行一次相同。","conversationId":null}`。

## 本地运行

1. 在本地 `8090` 端口启动 mock 服务，注册 `POST /ai/love/v1`，返回 `{"conversationId":"demo","answer":"你好"}` 即可联调聊天页面。
2. 使用 Node.js 24.17 或兼容版本（具体范围见 `package.json`；有 nvm 时可执行 `nvm use`）。
3. 在本目录执行：

```bash
npm ci
npm run dev
```

打开 <http://localhost:5174>。本机已有其他工程使用 5173，因此本项目使用 5174；端口被占用时会报错，不会悄悄改端口。

开发时，前端请求统一带 `/api` 前缀。Vite 代理去掉开头的 `/api` 后转发到 `http://localhost:8090`。例如浏览器请求 `POST /api/ai/love/v1`，mock 收到 `POST /ai/love/v1`。健康检查同理，`/api/health` 转为 `/health`。文档路径 `/v3/api-docs`、`/swagger-ui`、`/webjars` 按原路径转发。

若后端改了端口：

```bash
cp .env.example .env.local
```

编辑 `.env.local` 的 `BACKEND_URL`，例如 `http://localhost:8091`，再重启 `npm run dev`。不要把 API Key 放进前端或任何 `VITE_*` 变量；此处只配置后端地址。

## 页面行为

- 发送时立即清空输入框，并在消息区显示本次问题和等待状态。等待期间可以写下一条草稿，不能重复发送或切换会话。
- 请求失败且用户没有编辑新草稿时，恢复原文；若用户已编辑新草稿，保留新草稿，并将失败原文放到“恢复到输入框”入口中。不会用旧消息覆盖新输入。
- 模型回复经 `markdown-it` 解析，再经 `DOMPurify` 清理，支持标题、列表、引用、表格、链接、行内代码和代码块。用户输入始终按纯文本显示。
- 原始 HTML 不执行；图片语法显示为文字说明，不自动请求模型输出的远程图片。代码块保留排版，暂未添加语法高亮和数学公式渲染。
- 首轮只发送 `message`，接收后端返回的 `conversationId + answer`；后续请求自动带上同一个 ID。
- 会话只保存在当前页面内存中。刷新或“新建会话”会清空页面记录，下次发送不带旧 ID；这不会删除后端旧会话的记忆。
- FirstApp 的完整回复请求发往 `POST /api/ai/first-app`，事件流请求发往 `POST /api/ai/first-app/event-stream`。事件流开始时从 `turn.started` 读取会话编号，两种回复方式共用该编号。
- FirstApp 的完整回复和 `turn.started` 都携带服务端的到期时间 `expiresAt`。页面按这个时间标记过期会话，保留分隔线以上的消息，下次发送时开启新会话。若后端重启清空了内存，使用原 ID 续聊也可能得到一段空历史。
- SSE 默认等待首个事件 150 秒，后续每收到有效事件就重新计算 150 秒的空闲时限。完整回复仍从点击发送起计时。

## 结构

```text
src/
├── App.vue                       # 工作台、消息列表、输入框
├── main.js                       # Vue 挂载入口
├── api/chat.js                   # HTTP 请求、超时、响应检查
├── config/apps.js                # 已接入的应用及接口注册表
├── composables/useChat.js        # 会话 ID、消息、草稿、请求状态
├── components/MarkdownMessage.vue
├── utils/markdown.js             # Markdown 解析和 HTML 清理
└── styles/main.css               # 页面及 Markdown 样式
tests/                           # 离线请求状态与渲染测试
```

新增应用时先实现后端接口，再在 `APP_REGISTRY` 添加独立 `id`、`name`、`description`、`endpoint` 和 `suggestions`。默认共用 `{message, conversationId?} → {conversationId, answer}` 协议；不同协议先在请求层适配。状态按应用隔离，业务专属欢迎文案可以在 `App.vue` 中进一步组件化。

接入同一 SSE 协议的应用可以在注册表配置 `eventStreamEndpoint`。

## 验证与打包

```bash
npm test
npm run build
npm run preview
```

测试用模拟 HTTP 响应，不访问真实模型。`preview` 默认监听 4173，用于本地检查 `dist/`，同样可读取 `BACKEND_URL` 转发请求。

生产构建输出在 `dist/`。部署到静态服务器时，另行配置 `/api` 等路径到 Spring Boot 的反向代理；`vite.config.js` 的代理不会写进生产 JS，也不会自动变成生产服务器配置。若改变前端部署路径，需要同步设置 Vite `base` 和页面资源链接。

手动验收：发送“我叫小李”，确认点击后输入框立即清空；收到回复后继续问“我叫什么名字”，确认会话编号不变。再要求回复标题、列表、表格和 Java 代码块，确认显示为对应格式。这一步调用真实模型，会消耗后端配置的 API 额度。

框架参考：[Vue 3 快速开始](https://vuejs.org/guide/quick-start.html)、[Vite 开发代理](https://vite.dev/config/server-options.html#server-proxy)。

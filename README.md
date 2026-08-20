> **AI 生成项目：** 本项目及其源码由 AI 生成，使用前请自行审查实现与安全风险。

# codex-auth-to-local-api-key

把 Codex CLI 已登录的 ChatGPT/Codex 订阅转换为本地 OpenAI Responses 兼容接口。它不是 OpenAI Platform API Key，也不要将服务暴露到公网。

## 使用

需要 Node.js 24+ 和 Codex CLI。先在 `~/.codex/config.toml` 写入：

```toml
cli_auth_credentials_store = "file"
```

然后安装依赖并登录：

```bash
npm install
codex login
```

启动服务：

```bash
node index.js \
  --api-key sk-local-only-0000 \
  --model gpt-5.6-sol \
  --proxy-url http://127.0.0.1:7890
```

也可以运行 `npm start --` 后追加相同参数。默认监听 `http://127.0.0.1:10680/v1`。

调用示例：

```bash
curl http://127.0.0.1:10680/v1/responses \
  -H 'Authorization: Bearer sk-local-only-0000' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.6-sol","input":"Reply with: ok","stream":false}'
```

其他 Agent 自定义 Provider 配置：

```text
Base URL: http://127.0.0.1:10680/v1
API protocol: openai-responses
API key: sk-local-only-0000
Model: gpt-5.6-sol
```

## 常用参数

- `--api-key KEY`：本地 Bearer Key，默认必须提供
- `--unsafe-no-auth`：显式关闭本地认证，仅限可信的本机环境
- `--auth-file PATH`：Codex `auth.json` 路径
- `--proxy-url URL`：`env`、`direct` 或 HTTP(S) 代理 URL
- `--upstream-timeout-ms MS`：上游总超时，默认 300000 ms
- `--debug`：打印关键流程日志，不记录 Token 和请求正文
- `--help`：查看全部参数

`POST /v1/responses` 只接受 `Content-Type: application/json`。客户端断开会取消上游请求；非流式 SSE 和上游错误体均有大小限制。

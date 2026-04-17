# ⚙️ 配置详解

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
</p>

---

## 📌 配置方式

> 配置优先级：**环境变量 > config.json > 默认值**

---

## 🔧 环境变量

### 核心配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `PORT` / `OPENCODE_PROXY_PORT` | `10000` | 代理服务端口 |
| `OPENCODE_SERVER_PORT` | `10001` | OpenCode 后端服务端口 |
| `API_KEY` | - | Bearer Token 认证密钥 |
| `BIND_HOST` | `0.0.0.0` | 绑定地址 |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode 后端地址 |
| `OPENCODE_SERVER_PASSWORD` | - | OpenCode 后端密码 |

### 功能配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `OPENCODE_DISABLE_TOOLS` | `true` | 禁用 OpenCode 工具调用 |
| `OPENCODE_PROXY_MAX_IMAGE_BYTES` | `10485760` | 远程图片抓取最大字节数 |
| `OPENCODE_PROXY_ALLOW_PRIVATE_IMAGE_HOSTS` | `false` | 是否允许抓取内网/回环图片地址 |
| `OPENCODE_PROXY_MAX_CONCURRENT_REQUESTS` | `8` | 同时处理的最大请求数 |
| `USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录 |
| `PROMPT_MODE` | `standard` | 提示词处理模式 |
| `OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt |
| `AUTO_CLEANUP_CONVERSATIONS` | `false` | 自动清理会话存储 |
| `CLEANUP_INTERVAL_MS` | `43200000` | 清理间隔 (毫秒) |
| `CLEANUP_MAX_AGE_MS` | `86400000` | 最大存储时间 (毫秒) |
| `REQUEST_TIMEOUT_MS` | `180000` | 请求超时时间 (毫秒) |

### 调试配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `OPENCODE_ZEN_API_KEY` | - | Zen API Key 透传 |
| `OPENCODE_OPENAI_COMPAT_PROVIDER_ID` | `openai` | 注入到 OpenCode 的 OpenAI 兼容 provider ID |
| `OPENCODE_OPENAI_COMPAT_BASE_URL` | - | OpenAI 兼容接口基地址，例如 `https://api.moonshot.cn/v1` |
| `OPENCODE_OPENAI_COMPAT_API_KEY_ENV` | - | 供 OpenCode 读取的密钥环境变量名，例如 `MOONSHOT_API_KEY` |
| `OPENCODE_OPENAI_COMPAT_MODEL` | - | 默认主模型 ID（不含 provider 前缀），例如 `kimi-k2.5` |
| `OPENCODE_OPENAI_COMPAT_SMALL_MODEL` | - | 默认小模型 ID（不含 provider 前缀），未填时跟随主模型 |

---

## 📄 config.json 示例

```json
{
    "PORT": 10000,
    "API_KEY": "your-secret-api-key",
    "BIND_HOST": "0.0.0.0",
    "OPENCODE_DISABLE_TOOLS": true,
    "MAX_IMAGE_BYTES": 10485760,
    "ALLOW_PRIVATE_IMAGE_HOSTS": false,
    "MAX_CONCURRENT_REQUESTS": 8,
    "USE_ISOLATED_HOME": false,
    "PROMPT_MODE": "standard",
    "OMIT_SYSTEM_PROMPT": false,
    "AUTO_CLEANUP_CONVERSATIONS": false,
    "CLEANUP_INTERVAL_MS": 43200000,
    "CLEANUP_MAX_AGE_MS": 86400000,
    "DEBUG": false,
    "OPENCODE_SERVER_URL": "http://127.0.0.1:10001",
    "OPENCODE_PATH": "opencode",
    "REQUEST_TIMEOUT_MS": 180000
}
```

---

## 🎯 Prompt Mode 说明

| 模式 | 说明 |
|:-----|:-----|
| **standard** (默认) | 标准模式，完整处理提示词 |
| **plugin-inject** | 插件注入模式，减小模型侧提示词大小，通常与 `OMIT_SYSTEM_PROMPT=true` 配合使用 |

---

## ⭐ 推荐配置

### 🐳 Docker 生产环境

```bash
OPENCODE_DISABLE_TOOLS=true
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
OPENCODE_PROXY_MAX_IMAGE_BYTES=10485760
OPENCODE_PROXY_ALLOW_PRIVATE_IMAGE_HOSTS=false
OPENCODE_PROXY_MAX_CONCURRENT_REQUESTS=8
```

### 💻 本地开发

```bash
OPENCODE_DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```

### 🌙 Moonshot / Kimi 免手写 opencode.json

如果你希望直接通过环境变量把 Moonshot / Kimi 注入到 OpenCode，而不手动维护 `~/.config/opencode/opencode.json`，可以设置：

```bash
export MOONSHOT_API_KEY="<your-token>"
export OPENCODE_OPENAI_COMPAT_BASE_URL="https://api.moonshot.cn/v1"
export OPENCODE_OPENAI_COMPAT_API_KEY_ENV="MOONSHOT_API_KEY"
export OPENCODE_OPENAI_COMPAT_MODEL="kimi-k2.5"
export OPENCODE_OPENAI_COMPAT_SMALL_MODEL="kimi-k2.5"
```

启用后，`opencode2api-enhanced` 在启动受管 OpenCode 后端时会自动生成并注入对应 provider 配置，你无需手动写 `opencode.json`。

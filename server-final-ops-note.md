# opencode2api-enhanced 服务器最终运维说明

更新时间：2026-04-17
服务器：`*.*.*.*`
项目目录：`/root/opencode2api-enhanced`
服务端口：代理 `10000`，OpenCode backend `10001`

---

## 一、当前最终状态

当前服务已完成以下收口：

- 已接入 Moonshot / Kimi
- 已支持 `kimi-for-coding` 别名调用
- 已将敏感 token 从启动脚本中移出
- 已改为从 root-only 环境文件读取密钥
- 已配置 systemd 开机自启
- 当前 systemd 服务正常运行

---

## 二、当前运行结构

### 1）项目目录

```bash
/root/opencode2api-enhanced
```

### 2）启动脚本

```bash
/root/opencode2api-enhanced/run_proxy.sh
```

用途：
- 加载环境文件
- 设置 Moonshot / Kimi 相关环境变量
- 启动 `node index.js`

### 3）敏感环境文件

```bash
/root/.config/opencode2api.env
```

当前包含：
- `API_KEY`
- `MOONSHOT_API_KEY`

权限已收口为：

```bash
600
```

### 4）OpenCode 全局配置

```bash
/root/.config/opencode/opencode.json
```

当前已写入：
- Moonshot OpenAI 兼容 `baseURL`
- 默认 `model`
- 默认 `small_model`

### 5）systemd 服务

```bash
opencode2api.service
```

服务文件：

```bash
/etc/systemd/system/opencode2api.service
```

---

## 三、当前服务管理方式

### 查看状态

```bash
systemctl status opencode2api.service
```

### 启动服务

```bash
systemctl start opencode2api.service
```

### 停止服务

```bash
systemctl stop opencode2api.service
```

### 重启服务

```bash
systemctl restart opencode2api.service
```

### 查看是否开机自启

```bash
systemctl is-enabled opencode2api.service
```

### 查看是否正在运行

```bash
systemctl is-active opencode2api.service
```

---

## 四、日志查看方式

### 查看 systemd 日志

```bash
journalctl -u opencode2api.service -n 100 --no-pager
```

### 查看代理日志

```bash
tail -n 100 /root/opencode-proxy.log
```

### 持续跟日志

```bash
tail -f /root/opencode-proxy.log
```

---

## 五、健康检查与模型检查

### 健康检查

```bash
curl http://127.0.0.1:10000/health
```

### 模型列表

```bash
curl http://127.0.0.1:10000/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 检查是否有 Kimi

```bash
curl http://127.0.0.1:10000/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY" | grep -i kimi
```

---

## 六、当前 Kimi 接入方式

当前不是依赖手工长期维护 `opencode.json` 为主，而是：

- 原始代码已支持环境变量注入 OpenCode provider 配置
- 启动时会自动注入 Moonshot / Kimi provider
- 服务器真实 OpenCode 配置也已补齐，作为稳定兜底

### 当前关键环境变量逻辑

由启动脚本/环境文件配合提供：

- `MOONSHOT_API_KEY`
- `API_KEY`
- `OPENCODE_OPENAI_COMPAT_BASE_URL=https://api.moonshot.cn/v1`
- `OPENCODE_OPENAI_COMPAT_API_KEY_ENV=MOONSHOT_API_KEY`
- `OPENCODE_OPENAI_COMPAT_MODEL=kimi-k2.5`
- `OPENCODE_OPENAI_COMPAT_SMALL_MODEL=kimi-k2.5`
- `OPENCODE_OPENAI_COMPAT_PROVIDER_ID=openai`
- `OPENCODE_PROXY_MANAGE_BACKEND=true`
- `OPENCODE_PROFILE=tools-stable`

---

## 七、当前可直接使用的模型名

现在请求里可以直接使用：

```text
kimi-for-coding
```

也兼容这些别名：

- `kimi coding`
- `kimi-coding`
- `kimi_code`
- `kimi-code`

模型会自动解析到当前可用的 Kimi 编码模型。

---

## 八、请求示例

### Chat Completions

```bash
curl -X POST http://*.*.*.*:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kimi-for-coding",
    "messages": [
      {
        "role": "user",
        "content": "请写一个 Python 函数：把列表按每 3 个元素分组返回。"
      }
    ],
    "stream": false
  }'
```

### Responses API

```bash
curl -X POST http://*.*.*.*:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kimi-for-coding",
    "input": "写一个 TypeScript debounce 函数，并附上示例。",
    "stream": false
  }'
```

---

## 九、后续若要更新 token

如果后续轮换 Moonshot token：

### 1）编辑环境文件

```bash
vi /root/.config/opencode2api.env
```

更新：

```bash
MOONSHOT_API_KEY='新token'
```

### 2）重启服务

```bash
systemctl restart opencode2api.service
```

### 3）复查

```bash
curl http://127.0.0.1:10000/health
curl http://127.0.0.1:10000/v1/models -H "Authorization: Bearer YOUR_API_KEY" | grep -i kimi
```

---

## 十、已知注意事项

1. 之前排查过程中 token 曾出现在一次命令输出链路中。
   - 虽然后续已完成脚本脱敏与环境文件收口，
   - 但从安全角度，仍建议后续主动轮换一次 Moonshot token。

2. 当前 systemd 是唯一推荐主入口。
   - 后续不要再混用手工 `setsid` / `nohup` 常驻方式，
   - 避免和 systemd 抢占 `10000` 端口。

3. 如果出现服务起不来，优先检查：
   - `systemctl status opencode2api.service`
   - `journalctl -u opencode2api.service -n 100 --no-pager`
   - `tail -n 100 /root/opencode-proxy.log`

---

## 十一、当前基线结论

当前这台服务器的 `opencode2api-enhanced` 已进入可维护状态：

- systemd 托管
- Kimi 可用
- `kimi-for-coding` 可直接调用
- token 已从脚本中移出
- 后续维护以环境文件 + systemd 重启为主

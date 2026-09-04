# Nogi Relay 部署文档

本文件面向部署和维护人员，覆盖生产环境变量、数据库、Fly.io、官网浏览器会话、FCM 推送验证、媒体卷、日志、备份和厂商系统推送。

本地开发、代码结构、API 细节、Android 构建和安装请查看 [DEVELOPMENT.md](DEVELOPMENT.md)。项目入口见 [README.md](README.md)。
## 1. 服务器环境变量

### 必需配置

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接字符串 |
| `ACCESS_TOKEN` | 所有 `/v1/*` 接口和 `/init-db` 的 Bearer Token |
| `FIREBASE_PROJECT_ID` | Firebase 项目 ID |
| `FIREBASE_PRIVATE_KEY_BASE64` | Base64 编码的 Firebase Admin JSON，适合 Fly.io |
| `FIREBASE_PRIVATE_KEY_JSON` | 直接传入的 Firebase Admin JSON，可替代 Base64 |
| `FIREBASE_PRIVATE_KEY_PATH` | Firebase Admin JSON 文件路径，适合本地开发 |

Firebase 密钥三种方式只需配置一种，读取优先级为：Base64、JSON 字符串、文件路径。

### 乃木坂46监控配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NOGI_MONITOR_MODE` | 非 `browser` 时使用直接模式 | 生产环境建议设置为 `browser` |
| `NOGI_WEB_URL` | `https://message.nogizaka46.com` | 官方网页地址 |
| `NOGI_API_URL` | `https://api.message.nogizaka46.com` | 官方 API 地址 |
| `NOGI_APP_ID` | `jp.co.sonymusic.communication.nogizaka 2.5` | 官网请求头标识 |
| `NOGI_APP_PLATFORM` | `web` | 官网请求平台 |
| `NOGI_ORGANIZATION_ID` | `1` | 组织 ID |
| `NOGI_GROUP_IDS` | 空 | 手动限定成员 ID，逗号分隔；空值表示自动读取所有有效订阅 |
| `NOGI_POLL_INTERVAL_SECONDS` | `60` | 轮询间隔，代码限制最小 15 秒 |
| `NOGI_MESSAGE_COUNT` | `200` | 每个成员每轮读取数量，代码限制最大 200 |
| `NOGI_BACKFILL_ON_START` | `true` | 首轮保存历史消息但不推送 |
| `NOGI_ACCEPT_LANGUAGE` | `zh-CN,en-US,ja` | 官网 API 请求语言 |

### 浏览器模式配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NOGI_BROWSER_STATE_FILE` | `/data/nogi-browser-state.json` | 持久化浏览器登录状态 |
| `NOGI_BROWSER_HEADLESS` | `true` | 服务器使用无界面浏览器 |
| `NOGI_BROWSER_BLOCK_MEDIA` | `true` | 页面层阻止图片、媒体、字体，减少资源消耗 |
| `NOGI_BROWSER_AUTH_WAIT_SECONDS` | `30` | 等待页面发出授权请求的时间 |
| `NOGI_BROWSER_REQUEST_TIMEOUT_SECONDS` | `30` | 官网 API 请求超时 |
| `NOGI_BROWSER_SETTLE_SECONDS` | `8` | 页面加载后等待 TokenManager 完成工作的时间 |
| `NOGI_BROWSER_SESSION_REFRESH_INTERVAL_MINUTES` | `30` | 重新加载官网页面以维护会话的间隔 |
| `NOGI_BROWSER_RESTART_INTERVAL_SECONDS` | `1800` | 重建浏览器进程以释放内存的间隔 |
| `NOGI_BROWSER_EXECUTABLE_PATH` | 空 | 本地指定 Edge/Chrome/Chromium 路径 |
| `NOGI_BROWSER_CHANNEL` | headless 时为 `chromium-headless-shell` | Playwright 浏览器通道 |

浏览器模式不自行实现官网 refresh token 协议。官网页面负责刷新，监控进程只观察页面请求中的短期 `Authorization`，在内存中使用，并在官网刷新成功后重新保存浏览器状态。

### 直接模式配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NOGI_ACCESS_TOKEN` | 空 | 官网短期访问令牌 |
| `NOGI_REFRESH_TOKEN` | 空 | 官网刷新令牌 |
| `NOGI_AUTH_TKN` | 空 | 官网刷新请求可能需要的会话值 |
| `NOGI_TOKEN_FILE` | `/app/nogi-token.json` | 直接模式轮换 Token 的持久化文件 |
| `NOGI_TOKEN_REFRESH_INTERVAL_MINUTES` | `30` | 主动刷新间隔，最小 5 分钟 |

直接模式依赖官网当前实现，稳定性低于浏览器模式，生产环境优先使用浏览器模式。

### 媒体配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MEDIA_STORAGE_DIR` | `/app/nogi-media` | 归档文件目录；Fly.io 使用 `/data/nogi-media` |
| `MEDIA_MAX_BYTES` | `104857600` | 单个媒体最大 100 MB |
| `PUBLIC_BASE_URL` | `https://nogi-relay.fly.dev` | API 公网地址 |
| `PUBLIC_MEDIA_BASE_URL` | 回退到 `PUBLIC_BASE_URL` | 媒体服务公网地址；线上使用 8081 端口 |
| `NOGI_MEDIA_PORT` | `8081` | monitor 媒体 HTTP 服务内部端口 |

## 2. Fly.io 部署

### 2.1 部署拓扑

`fly.toml` 定义两个进程组：

- `app`：内部端口 8080，对外提供 HTTPS API。
- `monitor`：内部端口 8081，对外提供受认证保护的媒体服务。
- `monitor` 挂载 `nogi_media` 持久卷到 `/data`。
- API 至少保持一台机器运行，monitor 与 API 使用同一发布版本。
- Docker 基础镜像包含与 Playwright 匹配的 Chromium。

### 2.2 设置 Secret

```powershell
flyctl auth login
flyctl secrets set DATABASE_URL='YOUR_DATABASE_URL' -a nogi-relay
flyctl secrets set ACCESS_TOKEN='YOUR_RANDOM_ACCESS_TOKEN' -a nogi-relay
flyctl secrets set FIREBASE_PROJECT_ID='YOUR_FIREBASE_PROJECT_ID' -a nogi-relay
flyctl secrets set FIREBASE_PRIVATE_KEY_BASE64='YOUR_BASE64_FIREBASE_JSON' -a nogi-relay
```

Firebase 服务账号三选一：`FIREBASE_PRIVATE_KEY_BASE64`、`FIREBASE_PRIVATE_KEY_JSON` 或 `FIREBASE_PRIVATE_KEY_PATH`。生产环境优先使用 Base64 Secret。

检查 Secret 名称时只显示元数据，不会显示原文：

```powershell
flyctl secrets list -a nogi-relay
```

不要把 Secret 写进 `fly.toml`、README、日志或提交记录。Secret 丢失后只能重新设置，不能从 Fly.io 读取旧值。

### 2.3 初始化数据库

新数据库优先执行当前 schema：

```powershell
flyctl postgres connect -a YOUR_POSTGRES_APP
psql $env:DATABASE_URL -f .\server\database\schema.sql
```

也可以在 API 可访问后运行幂等初始化接口：

```powershell
$token = Read-Host 'ACCESS_TOKEN'
Invoke-RestMethod -Method Post -Uri 'https://nogi-relay.fly.dev/init-db' -Headers @{ Authorization = "Bearer $token" }
```

schema 会创建媒体字段 `media_local_path`、`thumbnail_local_path` 和来电背景字段 `phone_image_local_path`。API 启动时还会执行兼容性迁移。

### 2.4 上传官网浏览器会话

浏览器模式必须先在可信本机生成登录状态：

```powershell
Set-Location .\server
$env:NOGI_BROWSER_EXECUTABLE_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:NOGI_BROWSER_STATE_FILE = '.\nogi-browser-state.json'
npm ci
npm run bootstrap:browser
```

在官网窗口完成登录并确认能看到消息，回到终端按回车。生成的 state 文件包含 cookies、localStorage 和 IndexedDB，必须视为密码处理。

查询 monitor 机器 ID 并上传：

```powershell
Set-Location ..
flyctl status -a nogi-relay
flyctl ssh sftp put .\server\nogi-browser-state.json /data/nogi-browser-state.json -a nogi-relay --machine MONITOR_MACHINE_ID --mode 0600
flyctl machine restart MONITOR_MACHINE_ID -a nogi-relay
```

会话过期后重新生成并上传；不要把 `nogi-browser-state.json` 提交到 Git。

### 2.5 部署和回滚

```powershell
flyctl deploy --remote-only --app nogi-relay
flyctl status --app nogi-relay
Invoke-RestMethod 'https://nogi-relay.fly.dev/health'
flyctl logs --app nogi-relay --no-tail
```

发布完成前不要删除旧机器或持久卷。需要回滚时先列出历史版本，再选择已验证的镜像版本：

```powershell
flyctl releases --app nogi-relay
flyctl deploy --app nogi-relay --image registry.fly.io/nogi-relay:IMAGE_TAG
```

### 2.6 媒体卷

正式图片、语音、视频、缩略图和来电背景存储在 `/data/nogi-media/<消息ID>/`：

```text
media.<扩展名>
thumbnail.<扩展名>
phone_image.<扩展名>
```

来电背景通过 `/v1/messages/:id/media/phone_image` 提供，和其他媒体一样需要 Relay Bearer Token。持久卷不能跨应用自动复制，变更应用或区域前应先备份。

## 3. 生产验证

### 3.1 API 健康检查

```powershell
Invoke-RestMethod 'https://nogi-relay.fly.dev/health'
```

正常返回 `status: ok`。Fly 机器状态应显示 `app` 和 `monitor` 为 `started`，相应健康检查通过。

### 3.2 验证 Relay API Token

```powershell
$token = Read-Host 'ACCESS_TOKEN'
try {
  Invoke-RestMethod -Uri 'https://nogi-relay.fly.dev/v1/devices' -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 6
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

`200` 表示 Token 有效，`401` 表示缺失或错误，`429` 表示触发限流。所有 `/v1/*` 接口按来源 IP 限制为 15 分钟最多 100 次请求。

### 3.3 验证官网会话

浏览器模式下，短期官网 Token 只在 monitor 内存中使用，由官网页面维护刷新流程。查看日志：

```powershell
flyctl logs --app nogi-relay --no-tail
```

正常轮询会出现：

```text
Nogi browser monitor poll complete: groups=..., fetched=..., stored=..., pushed=...
```

常见失效信号：

- `Nogi API 401`：官网短期 Token 失效且页面刷新未恢复。
- 页面没有带 Authorization 的请求：浏览器状态未登录或已过期。
- `No active subscribed groups found`：没有有效订阅或账号配置不匹配。
- 浏览器反复重启：重新生成并上传 state 文件。

不要只解析 JWT 的 `exp` 判断官网会话，真实 API 请求成功才是最终判断。

## 4. 推送验收

### 4.1 普通消息

1. 在客户端允许通知，打开应用一次。
2. 在设置页保存 Relay 地址和 Token，点击保存并注册推送。
3. 调用 `/v1/push/test-message`。
4. 检查 `successCount >= 1` 且 `failureCount == 0`。
5. 分别测试前台、后台、锁屏和厂商系统清理后的通知到达情况。

### 4.2 全屏来电

1. 在概览页确认通知和全屏来电权限。
2. OPPO、vivo、小米等设备开启自启动、后台运行、锁屏显示和忽略电池优化。
3. 调用 `/v1/push/test-call`。
4. 等待客户端完成音频下载；准备阶段不应出现来电通知。
5. 验证锁屏、后台和应用前台时的来电页、铃声、背景图、接听和拒接。

测试接口生成的消息 ID 以 `test-call-` 开头，不写入正式消息表或推送日志；服务端会从受认证保护的 `/v1/push/test-call-audio.wav` 提供内置短 WAV，客户端在下载完成前不会显示来电页面。旧版本遗留的 `test-`/`test_` 行会在服务端启动时清理。

### 4.3 历史补偿

1. 临时关闭客户端网络。
2. 等待 monitor 收到一条正式消息。
3. 恢复网络并打开客户端。
4. 确认客户端前台同步补齐消息，即使此前没有收到 FCM。

## 5. 生产故障排查

### API 返回 401 或 429

- 确认请求头为 `Authorization: Bearer ...`。
- 确认客户端 Token 与 Fly Secret `ACCESS_TOKEN` 完全一致。
- Secret 更新后等待部署完成。
- 429 表示同一 IP 触发 15 分钟限流窗口。

### 设备注册成功但收不到 FCM

- 确认 APK 使用了与 `com.nogirelay.app` 匹配的 `google-services.json`。
- 确认 Firebase Admin 服务账号属于同一 Firebase 项目。
- 查询 `/v1/devices`，确认 `last_seen_at` 更新。
- 检查 FCM `successCount`/`failureCount` 和 Fly 日志。
- 检查国产系统通知、自启动、后台运行和电池限制。

### 来电只有通知栏，没有自动全屏

- Android 14 及更高版本开启应用的“使用全屏通知”特殊权限。
- 确认 `incoming_calls_v2` 通知通道为高重要性。
- 锁屏显示、后台弹出和自启动权限必须允许。
- 来电页只会在语音下载成功后显示；准备阶段的低重要性服务状态不等同于来电。
- 屏幕处于使用状态时，系统或厂商可能优先显示 heads-up 通知；应用会同时尝试直接启动来电页，失败时保留通知兜底。

### 媒体或来电背景无法显示

- 确认 `PUBLIC_MEDIA_BASE_URL` 指向 monitor 的 8081 服务。
- 确认请求携带 Relay Bearer Token。
- 检查 `/data/nogi-media/<消息ID>/phone_image.*` 是否存在。
- 确认消息字段 `phone_image_local_path` 已填充。
- 检查媒体下载日志和 100 MB 单文件限制。

### 官网监控停止更新

- 查看 monitor 日志中的 401、会话和订阅错误。
- 确认 `/data/nogi-browser-state.json` 存在且权限为 0600。
- 重新生成 state、上传并重启 monitor。
- 确认账号仍有有效成员订阅。

## 6. 日志、备份和恢复

### 日志

```powershell
flyctl logs --app nogi-relay --no-tail
flyctl machine status MONITOR_MACHINE_ID -a nogi-relay
```

不要在日志中输出官网 Token、Firebase 私钥、FCM Token 或浏览器 state 内容。

### 数据库备份

使用 PostgreSQL 官方工具定期备份：

```powershell
$env:PGPASSWORD = 'YOUR_DATABASE_PASSWORD'
pg_dump $env:DATABASE_URL --format=custom --file .\backup\nogi-relay-$(Get-Date -Format yyyyMMdd-HHmm).dump
```

备份目录不要提交 Git。恢复前停止 monitor，避免恢复期间继续写入消息：

```powershell
pg_restore --clean --if-exists --dbname $env:DATABASE_URL .\backup\YOUR_BACKUP.dump
```

### 媒体卷备份

数据库备份不包含 `/data/nogi-media`。使用 Fly Volume Snapshot 或同等方式备份持久卷，恢复时确保 `MEDIA_STORAGE_DIR` 与 `PUBLIC_MEDIA_BASE_URL` 一致。

## 7. 国产系统推送扩展

当前实现只接入 FCM。若需要提高应用被系统清理后的到达率，可增加：

```text
OPPO / ColorOS       -> OPPO PUSH / HeyTap Push
vivo / OriginOS      -> vivo Push
小米 / HyperOS       -> MiPush
其他支持 Google 的设备 -> FCM
```

接入厂商通道时，设备表应增加 `push_provider`、`provider_token` 和设备能力字段。厂商通知只携带消息 ID，客户端打开或回到前台后从 Relay 同步完整消息；不要无条件同时发送 FCM 和厂商通知，避免重复通知。

## 8. 限制与发布前检查

- 只实现 FCM，尚未接入 OPPO、vivo、小米或华为系统推送。
- API 使用单个共享 Token，没有用户级身份和权限体系。
- APK 默认 Token 会编译进包内，不适合公开分发。
- 服务端消息列表没有总数、游标和完整参数范围校验。
- FCM 无效设备 Token 需要运维清理。
- `test-call` 使用服务端内置短 WAV，只用于验证下载、推送和来电界面，不代表正式成员语音内容。
- Release APK 需要正式签名后才能对外发布。

发布前至少完成：数据库备份、媒体卷备份、健康检查、Token 验证、普通推送、全屏来电、历史补偿和旧测试数据清理验证。

## 9. 许可证与使用范围

服务端代码和依赖按各自许可证使用，项目服务端依赖声明 MIT。乃木坂46官方图片、音频、视频、商标和账号内容的再分发权不因代码许可证自动获得，部署和使用须遵守相关服务条款、订阅规则和当地法律。

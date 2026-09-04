# Nogi Relay

Nogi Relay 用于接收乃木坂46官方消息，归档文字和媒体，通过 Firebase Cloud Messaging（FCM）推送到 Android 客户端，并提供历史同步、搜索、分页、翻译和语音来电能力。

## 文档

| 文档 | 用途 |
| --- | --- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 代码结构、本地开发、API、数据库、Android 构建与安装 |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 生产配置、Fly.io 部署、官网会话、推送验收与运维 |

## 系统概览

```text
乃木坂46官网
    -> Playwright monitor（会话、轮询、媒体归档）
    -> PostgreSQL + Nogi Relay API
    -> Firebase Cloud Messaging
    -> Android 客户端（SQLite、通知、全屏语音来电）
```

服务端由 `app` 和 `monitor` 两个进程组组成：`app` 提供 REST API 和健康检查，`monitor` 维护官网会话、轮询订阅成员、保存媒体并触发推送。Android 客户端在启动、回到前台或手动同步时补齐历史消息。

## 核心能力

- 支持文字、图片、语音和视频消息。
- 正式媒体归档到持久化卷；语音来电的背景图片保存为每条消息目录中的 `phone_image.<扩展名>`。
- FCM 高优先级数据推送，客户端按消息 ID 去重。
- 语音来电先完成音频下载，再显示来电通知和全屏来电页。
- Android 客户端支持成员会话、全量搜索、分页、媒体查看、Download 文件夹保存和可选翻译。
- 测试消息和测试来电不写入正式消息日志；旧版本遗留测试数据会在服务端和客户端启动时清理。

## 目录

```text
app/                    Android 客户端
server/                 Node.js API、监控、媒体和数据库脚本
Dockerfile              Fly.io 镜像定义
fly.toml                Fly.io 进程、端口和持久卷配置
DEVELOPMENT.md          开发文档
DEPLOYMENT.md           部署文档
```

## 安全边界

Token、Firebase 服务账号、官网浏览器状态和 OpenAI API Key 都属于敏感数据，不应提交到仓库。当前 API 使用共享 Bearer Token，适合私人单租户部署；公开分发 APK 前应移除内置 Token，并改用设备级凭据。

## 许可证与使用范围

代码和服务端依赖的许可证说明见 [DEVELOPMENT.md](DEVELOPMENT.md) 与 [DEPLOYMENT.md](DEPLOYMENT.md) 末尾。乃木坂46官方图片、音频、视频和商标的再分发权不因本项目代码许可证自动获得，部署和使用须遵守相关服务条款与法律。

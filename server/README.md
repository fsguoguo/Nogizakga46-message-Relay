# Nogi Relay Server 文档入口

服务端开发、接口和本地运行说明请查看项目根目录的 [DEVELOPMENT.md](../DEVELOPMENT.md)。

生产环境变量、Fly.io 部署、官网会话上传、推送验收和运维说明请查看 [DEPLOYMENT.md](../DEPLOYMENT.md)。

服务端代码入口：

- `src/index.js`：REST API、健康检查和数据库兼容迁移。
- `src/monitor/nogi-web.js`：直接 API 监控模式。
- `src/monitor/nogi-browser.js`：浏览器会话监控模式。
- `src/services/media.js`：媒体和来电背景归档。
- `database/schema.sql`：当前数据库初始化脚本。
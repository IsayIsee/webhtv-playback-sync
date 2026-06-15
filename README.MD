# WebHTV 播放进度云同步服务

这是一个专门为 [WebHTV](https://github.com/fish2018/webhtv/) 定制的**播放进度多端同步后端服务**。项目采用 Node.js + Express 架构，底层依托高性能、零运维的 **Turso (LibSQL) 云数据库**，使用了[官方开发文档](https://github.com/fish2018/webhtv/blob/main/docs/%E5%BA%94%E7%94%A8%E5%AE%8C%E6%95%B4%E5%BC%80%E5%8F%91%E6%96%87%E6%A1%A3.md)中的协议规范。

## 🛠️ 环境环境变量配置 (.env)

在项目根目录下创建 `.env` 文件（生产环境请直接在服务商后台配置对应的环境变量）：

PORT=9980  
APP_AUTH_TOKEN=自定义安全 Token 用于客户端认证  
TURSO_DATABASE_URL=libsql://你的库名-你的用户名.turso.io  
TURSO_AUTH_TOKEN=你的Turso数据库访问令牌  

## 📦 本地快速启动

1. 克隆项目并进入根目录
2. 执行 `npm install` 安装必要的依赖（`express`, `@libsql/client`, `dotenv`）
3. 执行 `node index.js` 启动服务。
const express = require('express');
const { createClient } = require('@libsql/client');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 9980;

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

app.use(express.json());

// =========================================================================
// 全流量参数与上下文监视器
// =========================================================================
app.use((req, res, next) => {
    const startTime = Date.now();

    const originalJson = res.json;
    let capturedResponseBody = null;
    res.json = function (body) {
        capturedResponseBody = body;
        return originalJson.call(this, body);
    };

    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const statusCode = res.statusCode;

        let statusIcon = '[成功放行]';
        if (statusCode === 401) statusIcon = '[鉴权拦截]';
        if (statusCode === 404) statusIcon = '[路径未找到/404]';
        if (statusCode >= 500) statusIcon = '[服务端崩溃/500]';

        console.log(`\n======================================================================`);
        console.log(`访问端点: ${req.method} ${req.originalUrl || req.url}`);
        console.log(`响应耗时: ${duration}ms  |  状态码: ${statusCode}  |  结果: ${statusIcon}`);

        // 打印 URL 参数
        if (req.query && Object.keys(req.query).length > 0) {
            console.log(JSON.stringify(req.query, null, 2));
        } else {
            console.log("    (None)");
        }

        // 打印关 Headers
        console.log(`\n[Headers] >>>`);
        console.log(`   X-WebHTV-Token:      "${req.headers['x-webhtv-token'] || '未携带'}"`);
        console.log(`   X-WebHTV-Timestamp: "${req.headers['x-webhtv-timestamp'] || '未携带'}"`);
        console.log(`   X-WebHTV-Webhook-Id: "${req.headers['x-webhtv-webhook-id'] || '未携带'}"`);
        console.log(`   X-WebHTV-Dedupe-Key: "${req.headers['x-webhtv-dedupe-key'] || '未携带'}"`);
        console.log(`   X-WebHTV-Config-Key: "${req.headers['x-webhtv-config-key'] || '未携带'}"`);
        console.log(`   X-WebHTV-Config-Name:"${req.headers['x-webhtv-config-name'] || '未携带'}"`);
        console.log(`   Idempotency-Key:"${req.headers['idempotency-key'] || '未携带'}"`);

        // 打印 Request Body
        if (req.method !== 'GET' && req.method !== 'OPTIONS') {
            console.log(`\n[收到原始数据 (Request Body)] >>>`);
            console.log(JSON.stringify(req.body || {}, null, 2));
        }

        // 打印发 Response Body
        console.log(`\n[返回原始数据 (Response Body)] >>>`);
        if (capturedResponseBody) {
            const jsonString = JSON.stringify(capturedResponseBody, null, 2);
            console.log(jsonString.length > 2000 ? jsonString.substring(0, 2000) + `\n\n... (省略 ${jsonString.length - 2000} 字)` : jsonString);
        } else {
            console.log(`   (无 JSON 响应体)`);
        }
        console.log(`======================================================================`);
    });

    next();
});

// =========================================================================
// 🛡️ 鉴权中心
// =========================================================================
app.use(async (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WebHTV-Token, X-WebHTV-Config-Key, X-WebHTV-Config-Name');

    if (req.method === 'OPTIONS') return res.sendStatus(204);

    const rawHeaders = req.headers;
    let clientToken = '';
    const possibleKeys = ['x-webhtv-token', 'authorization'];

    for (const key of possibleKeys) {
        if (rawHeaders[key]) {
            clientToken = String(rawHeaders[key]).trim();
            break;
        }
        if (rawHeaders[key.toUpperCase()]) {
            clientToken = String(rawHeaders[key.toUpperCase()]).trim();
            break;
        }
    }

    if (!clientToken) {
        clientToken = req.query.token || req.query.X_WebHTV_Token || '';
        clientToken = String(clientToken).trim();
    }

    if (!clientToken) {
        return res.status(401).json({code: 401, message: "Unauthorized: Missing Token"});
    }

    try {
        const safeSql = `SELECT id FROM user_info WHERE token = ? LIMIT 1`;

        const result = await db.execute({
            sql: safeSql,
            args: [clientToken]
        });

        const rawRows = result.rows || [];

        if (rawRows.length === 0) {
            return res.status(401).json({code: 401, message: "Unauthorized: Invalid User Token"});
        }

        const user = rawRows[0];
        res.locals.userId = user.id;

        next();
    } catch (error) {
        console.error("Database auth error:", error);
        return res.status(500).json({code: 500, message: "Internal Server Error during auth"});
    }
});

// =========================================================================
// 远端同步源端点 (GET /)
// =========================================================================
app.get('/', async (req, res) => {
    const configKey = req.headers['x-webhtv-config-key'] || '';

    try {
        const safeSql = `
            SELECT 
                'webhtv.playback.v1' as schema,
                coalesce(event, '') as event,
                eventId, timestamp, sessionId, dedupeKey, cid,
                configKey, configName, historyKey, siteKey, siteName,
                vodId, vodName, vodPic, flag, episodeName, state,
                positionMs, durationMs, progress, speed, completed,
                key, appVersion, client, episodeUrl, episodeIndex, clientKey
            FROM playback_history
            WHERE configKey = ? and userId = ?
            ORDER BY timestamp DESC
        `;

        const result = await db.execute({
            sql: safeSql,
            args: [configKey, Number(res.locals.userId)]
        });

        const rawRows = result.rows || [];

        const sanitized = rawRows.map(r => {
            // 确保安全兼容 LibSQL/Turso 的行数据读取
            return {
                schema: r.schema ?? 'webhtv.playback.v1',
                event: r.event ?? '',
                eventId: r.eventId ?? '',
                timestamp: Number(r.timestamp) || Date.now(),
                sessionId: r.sessionId ?? '',
                dedupeKey: r.dedupeKey ?? '',
                cid: Number(r.cid) || 0,
                configKey: r.configKey ?? '',
                configName: r.configName ?? '',
                historyKey: r.historyKey ?? '',
                siteKey: r.siteKey ?? '',
                siteName: r.siteName ?? '',
                vodId: r.vodId ?? '',
                vodName: r.vodName ?? '',
                vodPic: r.vodPic ?? '',
                flag: r.flag ?? '',
                episodeName: r.episodeName ?? '',
                episodeUrl: r.episodeUrl ?? '',
                state: r.state ?? '',
                positionMs: Number(r.positionMs) || 0,
                durationMs: Number(r.durationMs) || 0,
                progress: Number(r.progress) || 0,
                speed: Number(r.speed) || 1,
                completed: !!r.completed,
                updateAt: Date.now(),
                client: r.client ?? '',
                appVersion: r.appVersion ?? '',
                clientKey: r.clientKey ?? ''
            };
        });

        res.status(200).json({"items": sanitized});

    } catch (err) {
        console.error(`查库失败:`, err.message);
        res.status(500).json({ code: 500, message: `Database error: ${err.message}` });
    }
});

// =========================================================================
// Webhook 接收端点(POST /api/webhook/playback)
// =========================================================================
app.post('/webhook/playback', async (req, res) => {
    const body = req.body || {};

    const items = Array.isArray(body)
        ? body
        : (Array.isArray(body.items) ? body.items : (Array.isArray(body.list) ? body.list : [body]));

    // 防止无效数据渗入
    const validItems = items.filter(item => item && (item.siteKey && item.vodId));

    if (validItems.length === 0) {
        return res.status(400).json({ code: 400, message: "Bad Request: No valid data" });
    }

    try {
        const statements = validItems.map(item => {
            // 获取每个视频的唯一值
            item.key = `${item.siteKey}_${item.vodId}`;

            return {
                sql: `INSERT INTO playback_history (
                    userId, schema, event, eventId, timestamp, sessionId, dedupeKey, cid,
                    configKey, configName, historyKey, siteKey, siteName, vodId, vodName, vodPic,
                    flag, episodeName, state, positionMs, durationMs, progress, speed, completed,
                    key, appVersion, client, episodeUrl, episodeIndex, clientKey
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(userId, key) DO UPDATE SET
                        schema=excluded.schema, event=excluded.event, eventId = excluded.eventId, 
                        timestamp=excluded.timestamp, sessionId=excluded.sessionId, dedupeKey=excluded.dedupeKey, cid=excluded.cid,
                        configKey=excluded.configKey, configName=excluded.configName, historyKey=excluded.historyKey, 
                        siteKey=excluded.siteKey, siteName=excluded.siteName, vodId=excluded.vodId, vodName=excluded.vodName, 
                        vodPic=excluded.vodPic, flag=excluded.flag, episodeName=excluded.episodeName, state = excluded.state,
                        positionMs=excluded.positionMs, durationMs=excluded.durationMs, progress=excluded.progress, 
                        speed=excluded.speed, completed=excluded.completed, appVersion=excluded.appVersion, client=excluded.client,
                        episodeUrl=excluded.episodeUrl, episodeIndex=excluded.episodeIndex, clientKey=excluded.clientKey`,
                args: [
                    Number(res.locals.userId),
                    item.schema ?? 'webhtv.playback.v1',
                    item.event ?? '',
                    item.eventId ?? '',
                    Number(item.timestamp) || Date.now(),
                    item.sessionId ?? '',
                    item.dedupeKey ?? '',
                    Number(item.cid) || 0,
                    item.configKey ?? '',
                    item.configName ?? '',
                    item.historyKey ?? '',
                    item.siteKey ?? '',
                    item.siteName ?? '',
                    item.vodId ?? '',
                    item.vodName || '未知视频',
                    item.vodPic || '',
                    item.flag ?? '',
                    item.episodeName ?? '',
                    item.state ?? '',
                    Number(item.positionMs) || 0,
                    Number(item.durationMs) || 0,
                    Number(item.progress) || 0,
                    Number(item.speed) || 1,
                    item.completed ? 1 : 0,
                    item.key,
                    item.appVersion ?? '',
                    item.client ?? '',
                    item.episodeUrl ?? '',
                    item.episodeIndex ?? '',
                    item.clientKey ?? ''
                ]
            };
        });

        await db.batch(statements, "write");
        res.status(200).json({ code: 0, message: `Synced ${statements.length} rows` });
    } catch (err) {
        console.error("Webhook 写入失败:", err.message);
        res.status(500).json({ code: 500, message: err.message });
    }
});

app.use((req, res) => { res.status(404).json({ code: 404, message: "Not found" }); });

// =========================================================================
// 数据库初始化与安全迁移
// =========================================================================
async function initDB() {
    try {
        console.log(`正在连接到 Turso 数据库...`);

        // 开启外键约束支持
        await db.execute("PRAGMA foreign_keys = ON;");

        await db.execute(`
            CREATE TABLE IF NOT EXISTS schema_version (
                id INTEGER PRIMARY KEY,
                version INTEGER NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS user_info (
                id INTEGER PRIMARY KEY,
                token TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expired_at DATETIME DEFAULT (datetime('now', '+1 year')),
                UNIQUE(token)
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS playback_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId INTEGER REFERENCES user_info(id) ON DELETE CASCADE,
                schema TEXT,
                event TEXT, 
                eventId TEXT,
                timestamp INTEGER,
                sessionId TEXT,
                dedupeKey TEXT,
                cid INTEGER,
                configKey TEXT,
                configName TEXT,
                historyKey TEXT,
                siteKey TEXT,
                siteName TEXT,
                vodId TEXT,
                vodName TEXT,
                vodPic TEXT,
                flag TEXT,
                episodeName TEXT,
                state TEXT,
                positionMs INTEGER,
                durationMs INTEGER,
                progress INTEGER,
                speed REAL,
                completed BOOLEAN NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
                key TEXT, 
                appVersion TEXT,
                client TEXT,
                episodeUrl TEXT,
                episodeIndex TEXT,
                clientKey TEXT,
                UNIQUE(userId, key)
            )
        `);

        let currentVersion = 1;
        const versionResult = await db.execute("SELECT version FROM schema_version WHERE id = 1");

        if (versionResult.rows.length === 0) {
            await db.execute("INSERT INTO schema_version (id, version) VALUES (1, 1)");
        } else {
            currentVersion = versionResult.rows[0].version;
        }
        console.log(`当前数据库 Schema 版本: v${currentVersion}`);

        const TARGET_VERSION = 1;

        if (currentVersion < TARGET_VERSION) {
            console.log(`检测到代码有升级，正在将数据库从 v${currentVersion} 迁移至 v${TARGET_VERSION}...`);
            const migrationTasks = [];

            if (currentVersion < 2) {
                migrationTasks.push({
                    sql: "ALTER TABLE playback_history ADD COLUMN deviceName TEXT DEFAULT 'Unknown'",
                    args: []
                });
            }

            migrationTasks.push({
                sql: "UPDATE schema_version SET version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
                args: [TARGET_VERSION]
            });

            await db.batch(migrationTasks, "write");
            console.log(`数据库成功升级至 v${TARGET_VERSION}！`);
        } else {
            console.log("数据库结构已是最新，无需迁移。");
        }
    } catch (err) { console.error("数据库初始化失败:", err.message); }
}

initDB();

app.listen(PORT, () => { console.log(`同步服务已启动。端口: ${PORT}`); });
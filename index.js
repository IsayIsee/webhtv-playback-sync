const express = require('express');
const { createClient } = require('@libsql/client');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 9980;
const APP_AUTH_TOKEN = process.env.APP_AUTH_TOKEN;

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
        console.log(`   x-webhtv-token:      "${req.headers['x-webhtv-token'] || '未携带'}"`);
        console.log(`   x-webhtv-config-key: "${req.headers['x-webhtv-config-key'] || '未携带'}"`);
        console.log(`   x-webhtv-config-name:"${req.headers['x-webhtv-config-name'] || '未携带'}"`);

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
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sync-Token, X-WebHTV-Token, X-WebHTV-Config-Key, X-WebHTV-Config-Name');

    if (req.method === 'OPTIONS') return res.sendStatus(204);

    const rawHeaders = req.headers;
    let clientToken = '';
    const possibleKeys = ['x-webhtv-token', 'x-sync-token', 'authorization'];

    for (const key of possibleKeys) {
        if (rawHeaders[key]) { clientToken = String(rawHeaders[key]).trim(); break; }
        if (rawHeaders[key.toUpperCase()]) { clientToken = String(rawHeaders[key.toUpperCase()]).trim(); break; }
    }
    if (!clientToken) {
        clientToken = req.query.token || req.query.X_WebHTV_Token || '';
        clientToken = String(clientToken).trim();
    }

    const expectedToken = String(APP_AUTH_TOKEN).trim();
    if (expectedToken && clientToken !== expectedToken) {
        return res.status(401).json({ code: 401, message: "Unauthorized: Token Mismatch" });
    }

    next();
});

// =========================================================================
// 远端同步源端点 (GET /)
// =========================================================================
app.get('/', async (req, res) => {
    const configKey = req.headers['x-webhtv-config-key'] || '';

    try {
        const safeSql = `
            SELECT 
                coalesce([key], '') as [key],
                coalesce(configKey, '') as configKey,
                coalesce(vodPic, '') as vodPic,
                coalesce(vodName, '未知视频') as vodName,
                coalesce(vodFlag, '') as vodFlag,
                coalesce(vodRemarks, '') as vodRemarks,
                coalesce(episodeUrl, '') as episodeUrl,
                coalesce(revSort, 0) as revSort,
                coalesce(revPlay, 0) as revPlay,
                coalesce(createTime, 0) as createTime,
                coalesce(opening, 0) as opening,
                coalesce(ending, 0) as ending,
                coalesce(position, 0) as position,
                coalesce(duration, 0) as duration,
                coalesce(speed, 1.0) as speed,
                coalesce(scale, 0) as scale,
                coalesce(cid, 0) as cid
            FROM playback_history 
            ORDER BY createTime DESC
        `;

        const result = await db.execute(safeSql) || {};
        const rawRows = result.rows || [];

        // 过滤匹配的 configKey
        const filteredRows = rawRows.filter(r => {
            if (!r) return false;
            return r.configKey === '' || r.configKey === configKey;
        });

        const sanitized = filteredRows.map(r => {
            let detectedSiteKey = '';
            let detectedVodId = '';
            const itemKey = String(r.key || '');

            if (itemKey.includes('_')) {
                const parts = itemKey.split('_');
                detectedSiteKey = parts[0];
                detectedVodId = parts.slice(1).join('_');
            }

            const finalDuration = Number(r.duration) || 3600000; // 默认总长 1 小时 (毫秒)
            const finalPosition = Number(r.position) || 1000;    // 默认已看 1 秒，防止为 0 被卡

            return {
                key: itemKey || `${detectedSiteKey}_${detectedVodId}`,
                siteKey: detectedSiteKey,
                vodId: detectedVodId,
                vodPic: r.vodPic,
                vodName: r.vodName,
                // 文本兜底：绝对不能返回空字符串给 App 历史界面
                vodFlag: r.vodFlag || detectedSiteKey || "默认线路",
                vodRemarks: r.vodRemarks || "已观看",
                episodeUrl: r.episodeUrl || "default_url",

                revSort: r.revSort === 1 || r.revSort === true,
                revPlay: r.revPlay === 1 || r.revPlay === true,
                createTime: Number(r.createTime) || Date.now(),
                opening: Number(r.opening) || 0,
                ending: Number(r.ending) || 0,

                // 进度兜底：强制大于 0
                position: finalPosition,
                duration: finalDuration,

                speed: Number(r.speed) || 1.0,
                scale: Number(r.scale) || 0,
                cid: Number(r.cid) || 0
            };
        });

        res.status(200).json(sanitized);

    } catch (err) {
        console.error(`查库失败:`, err.message);
        res.status(500).json({ code: 500, message: `Database error: ${err.message}` });
    }
});

// =========================================================================
// Webhook 接收端点(POST /api/webhook/playback)
// =========================================================================
app.post('/api/webhook/playback', async (req, res) => {
    const configKey = req.headers['x-webhtv-config-key'] || '';
    const body = req.body || {};

    // 转换为标准数组处理
    const items = Array.isArray(body)
        ? body
        : (Array.isArray(body.items) ? body.items : (Array.isArray(body.list) ? body.list : [body]));

    const validItems = items.filter(item => item && (item.key || (item.siteKey && item.vodId)));

    if (validItems.length === 0) {
        return res.status(400).json({ code: 400, message: "Bad Request: No valid data" });
    }

    try {
        const statements = validItems.map(item => {
            if (!item.key) item.key = `${item.siteKey}_${item.vodId}`;

            // 字段映射
            const finalPosition = item.positionMs !== undefined ? item.positionMs : (item.position || 0);
            const finalDuration = item.durationMs !== undefined ? item.durationMs : (item.duration || 0);
            const finalFlag = item.flag || item.vodFlag || '';
            const finalRemarks = item.episodeName || item.vodRemarks || '';

            return {
                sql: `INSERT INTO playback_history (
                        key, configKey, vodPic, vodName, vodFlag, vodRemarks, episodeUrl, revSort, revPlay, 
                        createTime, opening, ending, position, duration, speed, scale, cid
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        configKey=excluded.configKey, vodPic=excluded.vodPic, vodName=excluded.vodName, 
                        vodFlag=excluded.vodFlag, vodRemarks=excluded.vodRemarks, episodeUrl=excluded.episodeUrl, 
                        revSort=excluded.revSort, revPlay=excluded.revPlay, createTime=excluded.createTime, 
                        opening=excluded.opening, ending=excluded.ending, position=excluded.position, 
                        duration=excluded.duration, speed=excluded.speed, scale=excluded.scale, cid=excluded.cid`,
                args: [
                    item.key,
                    configKey || item.configKey || '',
                    item.vodPic || '',
                    item.vodName || '未知视频',
                    finalFlag,
                    finalRemarks,
                    item.episodeUrl || '',
                    item.revSort ? 1 : 0,
                    item.revPlay ? 1 : 0,
                    item.createTime || item.timestamp || Date.now(),
                    item.opening || 0,
                    item.ending || 0,
                    Number(finalPosition),
                    Number(finalDuration),
                    item.speed || 1.0,
                    item.scale || 0,
                    item.cid || 0
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

async function initDB() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS playback_history (key TEXT PRIMARY KEY, configKey TEXT, vodPic TEXT, vodName TEXT, vodFlag TEXT, vodRemarks TEXT, episodeUrl TEXT, revSort INTEGER, revPlay INTEGER, createTime INTEGER, opening INTEGER, ending INTEGER, position INTEGER, duration INTEGER, speed REAL, scale INTEGER, cid INTEGER)`);
        try { await db.execute("ALTER TABLE playback_history ADD COLUMN configKey TEXT DEFAULT ''"); } catch(e) {}
    } catch (e) { console.error(e); }
}
initDB();

app.listen(PORT, () => { console.log(`同步服务已启动。端口: ${PORT}`); });
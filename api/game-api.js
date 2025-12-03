// api/game-api.js - Vercel Serverless Function

// Vercel Functions 使用 Node.js 标准的 req, res 对象
export default async function handler(req, res) {
    
    // 1. 设置 CORS 头部
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 处理 OPTIONS 预检请求 (解决 405 Method Not Allowed)
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 2. 安全获取 API Key
    const apiKey = process.env.DEEPSEEK_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'Server configuration error: DEEPSEEK_API_KEY is missing.' });
    }

    try {
        // Vercel Node.js 环境下，请求体需要通过 req.body 获取
        const requestBody = req.body; 

        // 3. 调用 DeepSeek API
        const aiResponse = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: requestBody.messages,
                temperature: 1.3,
                response_format: { type: "json_object" }
            })
        });

        const aiData = await aiResponse.json();

        // 4. 检查 DeepSeek 状态码
        if (!aiResponse.ok) {
             return res.status(aiResponse.status).json({ 
                error: `DeepSeek API failed with status ${aiResponse.status}`,
                detail: aiData 
             });
        }
        
        // 5. 成功返回结果
        return res.status(200).json(aiData);

    } catch (error) {
        console.error("Vercel Function Internal Error:", error);
        return res.status(500).json({ error: 'Internal server error during AI processing.', detail: error.message });
    }
}

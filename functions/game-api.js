// functions/game-api.js

async function handleRequest(request) {
  // 1. 处理 CORS (允许你的前端域名访问)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*", // 生产环境建议换成你的具体域名
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // 2. 获取请求体 (包含 prompt 或 messages)
    const requestBody = await request.json();

    // 3. 从环境变量获取 API Key (在 EdgeOne 控制台配置)
    // 注意：EdgeOne 环境变量读取方式可能因版本不同略有差异，通常是直接通过 key 访问
    // 假设环境变量名为 DEEPSEEK_API_KEY
    const apiKey = DEEPSEEK_API_KEY; 

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API Key未配置" }), { status: 500 });
    }

    // 4. 调用 DeepSeek API
    const aiResponse = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: requestBody.messages, // 前端传来的完整对话上下文
        temperature: 1.3, // 高创造性
        response_format: { type: "json_object" } // 强制让 AI 返回 JSON
      })
    });

    const aiData = await aiResponse.json();

    // 5. 返回结果给前端
    return new Response(JSON.stringify(aiData), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

// edge-functions/game-api.js - 增强错误处理版本

// 1. 定义一个安全的 Key 获取函数
// EdgeOne 运行时环境可能直接将环境变量提升为全局变量，但必须使用 try-catch 或 typeof 检查。
const getApiKey = () => {
    // 尝试直接访问全局变量（EdgeOne 常见方式）
    if (typeof DEEPSEEK_API_KEY !== 'undefined' && DEEPSEEK_API_KEY) {
        return DEEPSEEK_API_KEY;
    }
    // 如果直接访问失败，尝试使用 process.env (兼容Node.js)
    if (typeof process !== 'undefined' && process.env.DEEPSEEK_API_KEY) {
        return process.env.DEEPSEEK_API_KEY;
    }
    return null;
};


async function handleRequest(request) {
  // 确保 CORS 头部正确设置
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // 生产环境请换成你的具体域名
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const apiKey = getApiKey();

  // 【最关键的检查】如果 API Key 缺失，返回 JSON 错误，避免 ReferenceError 崩溃。
  if (!apiKey) {
      return new Response(JSON.stringify({ error: "DEEPSEEK_API_KEY 未找到。请在 EdgeOne Pages 设置中配置环境变量。" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
      });
  }

  try {
    const requestBody = await request.json();

    // 2. 调用 DeepSeek API
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
    
    // 3. 检查 DeepSeek 返回的状态码
    if (!aiResponse.ok) {
        // 如果 DeepSeek 返回 4xx/5xx 错误，读取其内容并返回给前端，状态码保持不变。
        const errorDetail = await aiResponse.text();
        return new Response(JSON.stringify({ 
            error: `DeepSeek API调用失败，状态码: ${aiResponse.status}`,
            detail: errorDetail 
        }), {
            status: aiResponse.status,
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });
    }

    // 4. 返回 DeepSeek 的 JSON 数据
    const aiData = await aiResponse.json();
    return new Response(JSON.stringify(aiData), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  } catch (error) {
    // 捕获请求体解析失败、JSON解析失败等内部错误，并返回 JSON 格式
    return new Response(JSON.stringify({ 
        error: "Edge Function 内部处理失败", 
        detail: error.message 
    }), { 
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders } 
    });
  }
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

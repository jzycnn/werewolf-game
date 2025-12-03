// ====== 配置区 ======
// 这里填入你的 Edge Functions 的触发地址 (部署后在 EdgeOne 控制台获取)
// 本地开发时可能是 http://localhost:8080 类似的地址，上线后是 https://xxx.pages.woa.com/game-api
const API_ENDPOINT = '/functions/game-api'; 

// ====== 游戏状态 ======
const ROLES = [
    '狼人', '狼人', '狼人', '狼人',
    '村民', '村民', '村民', '村民',
    '预言家', '女巫', '猎人', '白痴'
];

let gameState = {
    players: [], // {id, role, alive, knownInfo}
    userIndex: -1,
    dayCount: 0,
    history: [], // 发送给AI的对话历史
    isProcessing: false
};

// ====== 初始化 ======
document.getElementById('start-btn').addEventListener('click', startGame);
const storyLog = document.getElementById('story-log');

function startGame() {
    // 1. 初始化音频上下文 (解决浏览器自动播放限制)
    initTTS(); 
    
    // 2. 分配角色
    let shuffled = [...ROLES].sort(() => Math.random() - 0.5);
    gameState.userIndex = Math.floor(Math.random() * 12);
    gameState.players = shuffled.map((role, idx) => ({
        id: idx + 1,
        role: role,
        alive: true,
        isUser: idx === gameState.userIndex
    }));

    // 3. 渲染座位
    renderSeats();

    // 4. 更新UI
    document.getElementById('start-btn').classList.add('hidden');
    document.getElementById('my-role-display').innerText = `您的身份: ${gameState.players[gameState.userIndex].role} (${gameState.userIndex+1}号)`;
    document.getElementById('mic-btn').classList.remove('hidden');

    // 5. 构造初始 System Prompt (这是AI的灵魂)
    const systemPrompt = `
    你是一个中国古风狼人杀游戏的【法官】兼【所有AI玩家】的大脑。
    背景：深宅大院，迷雾重重，局势诡谲。
    
    【游戏配置】
    12人局：4狼人，4村民，4神(预言家,女巫,猎人,白痴)。
    用户是 ${gameState.userIndex + 1} 号玩家。
    
    【玩家真实底牌】(严禁在普通发言中直接暴露，除非符合逻辑):
    ${JSON.stringify(gameState.players.map(p => `${p.id}号:${p.role}`).join(', '))}

    【你的任务】
    1. 控制游戏流程 (天黑->狼人行动->女巫->预言家->天亮->竞选警长->发言->投票)。
    2. 扮演法官：通过 "judge_speak" 字段输出主持词，风格要古朴、悬疑。
    3. 扮演AI玩家：轮到AI发言时，通过 "ai_speak" 输出内容。狼人要伪装，好人要找狼。
    
    【输出格式】
    你必须只返回一个 JSON 对象，不要Markdown。格式如下：
    {
        "thought": "简短的思维链，决定下一步做什么",
        "judge_speak": "法官的主持台词，如果没有则为空字符串",
        "ai_speak": { "seat_id": 3, "content": "3号玩家的发言内容" } (如果没有AI发言则为null),
        "game_event": "描述发生了什么，例如 '5号死亡'",
        "next_phase": "用于前端判断阶段，例如 'vote', 'user_turn', 'continue'"
    }
    
    现在游戏开始，请输出第一夜的开场词。
    `;

    gameState.history = [{ role: "system", content: systemPrompt }];
    
    // 6. 触发第一轮
    processGameTurn("游戏开始，进入第一夜");
}

function renderSeats() {
    const container = document.getElementById('seats-area');
    container.innerHTML = '';
    gameState.players.forEach(p => {
        let div = document.createElement('div');
        div.className = `seat ${p.isUser ? 'user' : ''}`;
        div.id = `seat-${p.id}`;
        div.innerText = `${p.id}号 ${p.isUser ? '(你)' : ''}`;
        container.appendChild(div);
    });
}

// ====== AI 核心交互 ======
async function processGameTurn(userActionDescription) {
    if (gameState.isProcessing) return;
    gameState.isProcessing = true;
    updateStatus("天机推演中...");

    // 添加用户动作到历史
    gameState.history.push({ role: "user", content: userActionDescription });

    try {
        // 请求 Edge Function
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: gameState.history })
        });

        const data = await response.json();
        
        // 解析 DeepSeek 返回的 JSON 内容
        let content = data.choices[0].message.content;
        // 清理可能的 markdown 标记
        content = content.replace(/```json/g, '').replace(/```/g, '');
        
        const aiResult = JSON.parse(content);
        
        // 保存 AI 回复到历史，保持上下文连贯
        gameState.history.push({ role: "assistant", content: JSON.stringify(aiResult) });

        // --- 执行 UI 反馈 ---
        
        // 1. 法官说话 (TTS + 文本)
        if (aiResult.judge_speak) {
            addLog("judge", aiResult.judge_speak);
            await speakText(aiResult.judge_speak); // 等待语音播完
        }

        // 2. AI 玩家说话
        if (aiResult.ai_speak) {
            highlightSeat(aiResult.ai_speak.seat_id);
            addLog("ai", `${aiResult.ai_speak.seat_id}号: ${aiResult.ai_speak.content}`);
            await speakText(`${aiResult.ai_speak.seat_id}号说: ${aiResult.ai_speak.content}`);
            unhighlightSeat(aiResult.ai_speak.seat_id);
        }

        // 3. 处理游戏状态
        if (aiResult.next_phase === "user_turn") {
            updateStatus("轮到你发言了 (按住按钮)");
            // 解锁麦克风按钮
        } else if (aiResult.next_phase === "vote") {
            // 这里可以弹出一个投票框 (简化版：直接让你说话投票)
            updateStatus("请发言进行投票或操作");
        } else {
            // 如果 AI 觉得还没轮到用户，继续自动推进 (递归调用)
            // 稍微延迟一点，避免请求太快
            setTimeout(() => {
                processGameTurn("继续流程");
            }, 1000);
        }

    } catch (e) {
        console.error(e);
        addLog("system", "系统错误: " + e.message);
    } finally {
        gameState.isProcessing = false;
    }
}

// ====== 语音转文字 (STT) - Web Speech API ======
const micBtn = document.getElementById('mic-btn');
let recognition;

if ('webkitSpeechRecognition' in window) {
    recognition = new webkitSpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    
    micBtn.onmousedown = () => {
        recognition.start();
        micBtn.innerText = "正在聆听...";
        micBtn.style.background = "#8f1e1e";
    };
    
    micBtn.onmouseup = () => {
        recognition.stop();
        micBtn.innerText = "按住说话";
        micBtn.style.background = "";
    };

    recognition.onresult = (event) => {
        const text = event.results[0][0].transcript;
        addLog("user", `你: ${text}`);
        // 将用户的话发给 AI
        processGameTurn(`用户(${gameState.userIndex+1}号)发言: "${text}"`);
    };
} else {
    micBtn.innerText = "浏览器不支持语音";
    micBtn.disabled = true;
}

// ====== 语音合成 (TTS) ======
function initTTS() {
    // 触发一下，确保移动端能播放
    window.speechSynthesis.cancel();
}

function speakText(text) {
    return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = 1.0; 
        
        // 尝试选择一个中文语音
        let voices = window.speechSynthesis.getVoices();
        let zhVoice = voices.find(v => v.lang.includes('zh'));
        if (zhVoice) u.voice = zhVoice;

        u.onend = resolve;
        window.speechSynthesis.speak(u);
    });
}

// ====== 辅助 UI 函数 ======
function addLog(type, text) {
    let div = document.createElement('div');
    div.className = `msg ${type}`;
    div.innerText = text;
    storyLog.appendChild(div);
    storyLog.scrollTop = storyLog.scrollHeight;
}

function updateStatus(text) {
    document.getElementById('status-bar').innerText = text;
}

function highlightSeat(id) {
    const el = document.getElementById(`seat-${id}`);
    if(el) el.classList.add('active');
}

function unhighlightSeat(id) {
    const el = document.getElementById(`seat-${id}`);
    if(el) el.classList.remove('active');
}

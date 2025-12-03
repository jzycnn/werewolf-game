// public/game.js - 核心游戏逻辑

// ====== 配置区 ======
// Vercel Serverless Function 路径
const API_ENDPOINT = '/api/game-api'; 

// ====== 游戏状态 ======
const ROLES = [
    '狼人', '狼人', '狼人', '狼人',
    '村民', '村民', '村民', '村民',
    '预言家', '女巫', '猎人', '白痴'
];

let gameState = {
    players: [], // {id, role, alive, isUser}
    userIndex: -1,
    dayCount: 0,
    history: [], // 发送给AI的对话历史
    isProcessing: false
};

// ====== DOM 元素引用 ======
document.getElementById('start-btn').addEventListener('click', startGame);
const storyLog = document.getElementById('story-log');
const actionBar = document.querySelector('.action-bar');
const actionButtonsArea = document.getElementById('action-buttons-area');

function startGame() {
    // 1. 初始化音频上下文
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

    // 4. 更新UI 和狼人提示
    document.getElementById('start-btn').classList.add('hidden');
    document.getElementById('mic-btn').classList.remove('hidden');

    const userRole = gameState.players[gameState.userIndex].role;
    let roleText = `您的身份: ${userRole} (${gameState.userIndex + 1}号)`;

    if (userRole === '狼人') {
        const wolfPartners = gameState.players
            .filter(p => p.role === '狼人' && !p.isUser)
            .map(p => `${p.id}号`);
        
        if (wolfPartners.length > 0) {
            roleText += ` - 狼人伙伴: ${wolfPartners.join('、')}号`;
            addLog("system", `【天黑请闭眼】您的狼人伙伴是 ${wolfPartners.join('、')} 号玩家。请共商大计。`, 'system-important');
        }
    }

    document.getElementById('my-role-display').innerText = roleText;


    // 5. 构造初始 System Prompt (这是AI的灵魂)
    const systemPrompt = `
    你是一个中国古风狼人杀游戏的【法官】兼【所有AI玩家】的大脑。
    背景：深宅大院，迷雾重重，局势诡谲。
    
    【游戏配置】
    12人局：4狼人，4村民，4神(预言家,女巫,猎人,白痴)。
    用户是 ${gameState.userIndex + 1} 号玩家，身份是 ${userRole}。
    
    【玩家真实底牌】(严禁在普通发言中直接暴露，除非符合逻辑):
    ${JSON.stringify(gameState.players.map(p => `${p.id}号:${p.role}`).join(', '))}

    【你的任务】
    1. 控制游戏流程 (天黑->狼人行动->女巫->预言家->天亮->发言->投票)。
    2. 扮演法官：通过 "judge_speak" 字段输出主持词，风格要古朴、悬疑。
    3. 扮演AI玩家：轮到AI发言时，通过 "ai_speak" 输出内容。
    4. 阶段控制：在需要用户（${gameState.userIndex + 1}号）发言时，返回 "next_phase": "user_turn"。在需要用户进行技能操作时，返回对应的阶段名称和可操作目标。
    
    【输出格式】
    你必须只返回一个 JSON 对象，不要Markdown。格式如下：
    {
        "thought": "简短的思维链，决定下一步做什么",
        "judge_speak": "法官的主持台词，如果没有则为空字符串",
        "ai_speak": { "seat_id": 3, "content": "3号玩家的发言内容" } (如果没有AI发言则为null),
        "game_event": "描述发生了什么，例如 '5号死亡'",
        "current_phase": "当前游戏阶段（如 Day, Night, Vote, SeerAction）",
        "targets": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] (在行动或投票阶段，列出所有存活玩家的ID),
        "next_phase": "用于前端判断阶段：'user_turn', 'vote', 'kill_target', 'seer_check', 'continue'"
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
    
    setUserTurn(false); // 在处理过程中禁用用户操作

    // 添加用户动作到历史
    gameState.history.push({ role: "user", content: userActionDescription });

    try {
        // 请求 Vercel Serverless Function
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: gameState.history })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Proxy/AI 错误，状态码: ${response.status}。详情: ${errorData.error}`);
        }

        const data = await response.json();
        
        let content = data.choices[0].message.content;
        content = content.replace(/```json/g, '').replace(/```/g, '');
        
        const aiResult = JSON.parse(content);
        
        // 保存 AI 回复到历史
        gameState.history.push({ role: "assistant", content: JSON.stringify(aiResult) });

        // --- 执行 UI 反馈 ---
        
        // 1. 法官说话 (TTS + 文本)
        if (aiResult.judge_speak) {
            addLog("judge", aiResult.judge_speak);
            await speakText(aiResult.judge_speak); 
        }

        // 2. AI 玩家说话
        if (aiResult.ai_speak) {
            highlightSeat(aiResult.ai_speak.seat_id);
            addLog("ai", `${aiResult.ai_speak.seat_id}号: ${aiResult.ai_speak.content}`);
            await speakText(`${aiResult.ai_speak.seat_id}号说: ${aiResult.ai_speak.content}`);
            unhighlightSeat(aiResult.ai_speak.seat_id);
        }
        
        // 3. 处理游戏事件（如死亡）
        if (aiResult.game_event) {
            addLog("system-important", `【事件】 ${aiResult.game_event}`);
        }

        // 4. 处理用户行动阶段
        const nextPhase = aiResult.next_phase;
        
        if (nextPhase === "user_turn") {
            // 提示用户可以自由发言
            setUserTurn(true);
            actionButtonsArea.innerHTML = '';
        } else if (nextPhase === "kill_target" || nextPhase === "vote" || nextPhase === "seer_check" || nextPhase === "witch_action") {
            // 提示用户需要点击按钮进行技能操作或投票
            setUserTurn(true);
            renderUserActionButtons(nextPhase, aiResult.targets || []);
        } else {
            // 继续自动推进流程
            setUserTurn(false);
            actionButtonsArea.innerHTML = '';
            setTimeout(() => {
                processGameTurn("继续流程");
            }, 1000);
        }

    } catch (e) {
        console.error("游戏回合处理失败:", e);
        addLog("system-important", `致命错误，请查看控制台。AI/网络错误信息: ${e.message}`);
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
        if (!micBtn.disabled) {
            recognition.start();
            micBtn.innerText = "正在聆听...";
            micBtn.style.background = "#8f1e1e";
        }
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
    window.speechSynthesis.cancel();
}

function speakText(text) {
    return new Promise((resolve) => {
        if (!text) return resolve();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = 1.0; 
        
        let voices = window.speechSynthesis.getVoices();
        let zhVoice = voices.find(v => v.lang.includes('zh'));
        if (zhVoice) u.voice = zhVoice;

        u.onend = resolve;
        window.speechSynthesis.speak(u);
    });
}

// ====== 动态按钮渲染和事件处理 ======

function renderUserActionButtons(phase, targets) {
    actionButtonsArea.innerHTML = '';
    const user = gameState.players[gameState.userIndex];
    
    // 隐藏麦克风，聚焦按钮操作
    document.getElementById('mic-btn').classList.add('hidden');

    let buttonTitle = '进行投票';
    let actionType = 'vote';

    // 根据阶段和身份确定行动类型和提示
    if (phase === 'kill_target' && user.role === '狼人') {
        buttonTitle = '狼人请选择击杀目标';
        actionType = 'kill';
    } else if (phase === 'seer_check' && user.role === '预言家') {
        buttonTitle = '预言家请验人';
        actionType = 'check';
    } else if (phase === 'witch_action' && user.role === '女巫') {
        // 女巫通常需要两个动作：救人或毒人
        // 简化处理：女巫阶段，先显示救人/不救按钮，如果选择不救/救人成功，再显示毒人/不毒按钮。
        // 为了简化，这里只做目标选择，AI 需要根据状态处理女巫的药。
        buttonTitle = '女巫请选择行动目标';
        actionType = 'witch_target';
    } 
    
    // 确保只显示存活的玩家作为目标，并且不包含自己
    const availableTargets = gameState.players
        .filter(p => p.alive && targets.includes(p.id))
        .map(p => p.id);

    addLog("system-important", `【${buttonTitle}】请点击选择座位号。`);

    // 渲染目标按钮
    availableTargets.forEach(targetId => {
        let btn = document.createElement('button');
        btn.className = 'ink-btn action-target-btn';
        btn.innerText = `${targetId}号`;
        
        btn.onclick = () => {
            document.querySelectorAll('.action-target-btn').forEach(b => b.disabled = true);
            
            // 构建发送给 AI 的行动文本
            let actionText = `${user.role}(${user.id}号)执行了[${actionType}]行动，目标是 ${targetId}号`;
            
            actionButtonsArea.innerHTML = ''; // 清空按钮区
            document.getElementById('mic-btn').classList.remove('hidden');

            processGameTurn(actionText); 
        };
        actionButtonsArea.appendChild(btn);
    });
    
    // 如果是女巫，或不想行动，提供一个“放弃”按钮
    if (user.role !== '村民' && availableTargets.length > 0) {
        let skipBtn = document.createElement('button');
        skipBtn.className = 'ink-btn action-target-btn';
        skipBtn.innerText = '放弃行动';
        skipBtn.onclick = () => {
             processGameTurn(`${user.role}(${user.id}号)选择了放弃行动`);
             actionButtonsArea.innerHTML = '';
             document.getElementById('mic-btn').classList.remove('hidden');
        };
        actionButtonsArea.appendChild(skipBtn);
    }
}

// ====== 辅助 UI 函数 ======

function setUserTurn(isUserTurn) {
    if (isUserTurn) {
        actionBar.classList.add('user-turn');
        document.getElementById('mic-btn').disabled = false;
        // 语音提示只在需要发言时触发
        if (actionButtonsArea.innerHTML === '') { 
             speakText("现在轮到你发言了。"); 
        }
    } else {
        actionBar.classList.remove('user-turn');
        document.getElementById('mic-btn').disabled = true;
    }
}

function updateStatus(text) {
    document.getElementById('status-bar').innerText = text;
}

function addLog(type, text) {
    let div = document.createElement('div');
    // 使用 type 参数来处理 system-important 样式
    div.className = `msg ${type}`;
    div.innerText = text;
    storyLog.appendChild(div);
    storyLog.scrollTop = storyLog.scrollHeight; // 自动滚到底部
}

function highlightSeat(id) {
    const el = document.getElementById(`seat-${id}`);
    if(el) el.classList.add('active');
}

function unhighlightSeat(id) {
    const el = document.getElementById(`seat-${id}`);
    if(el) el.classList.remove('active');
}

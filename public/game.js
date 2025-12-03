// public/game.js - 核心游戏逻辑

// ====== 配置区 ======
// Vercel Serverless Function 路径
const API_ENDPOINT = '/api/game-api'; 
const MANUAL_PUSH_PROMPT = "GO_TO_NEXT_PHASE_MANUAL_PUSH"; // 用户点击“下一步”时发送给AI的信号

// ====== 游戏状态 ======
// 12人板子：4狼人, 4村民, 预言家, 女巫, 猎人, 白痴
const ROLES = [
    '狼人', '狼人', '狼人', '狼人',
    '村民', '村民', '村民', '村民',
    '预言家', '女巫', '猎人', '白痴'
];

let gameState = {
    players: [], // {id, role, alive, isUser, hasBullet, hasPoison, hasAntidote, isIdiotFlipped}
    userIndex: -1,
    dayCount: 0,
    history: [], // 发送给AI的对话历史
    isProcessing: false,
    sheriff: null // 警长ID
};

// ====== DOM 元素引用 ======
document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('next-step-btn').addEventListener('click', handleNextStep);
const storyLog = document.getElementById('story-log');
const actionBar = document.querySelector('.action-bar');
const actionButtonsArea = document.getElementById('action-buttons-area');
const micBtn = document.getElementById('mic-btn');
const nextStepBtn = document.getElementById('next-step-btn');

function startGame() {
    // 1. 初始化音频上下文
    initTTS(); 
    
    // 2. 分配角色
    let shuffled = [...ROLES].sort(() => Math.random() - 0.5);
    gameState.userIndex = Math.floor(Utility.getRandomAlivePlayerIndex(shuffled.length));
    gameState.dayCount = 0;
    gameState.sheriff = null;
    
    gameState.players = shuffled.map((role, idx) => ({
        id: idx + 1,
        role: role,
        alive: true,
        isUser: idx === gameState.userIndex,
        // 角色状态
        hasBullet: role === '猎人',
        hasPoison: role === '女巫',
        hasAntidote: role === '女巫',
        isIdiotFlipped: false
    }));

    // 3. 渲染座位
    renderSeats();

    // 4. 更新UI 和狼人提示
    document.getElementById('start-btn').classList.add('hidden');
    
    const user = gameState.players[gameState.userIndex];
    let roleText = `您的身份: ${user.role} (${user.id}号)`;

    if (user.role === '狼人') {
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
    const systemPrompt = createComplexSystemPrompt(user);
    gameState.history = [{ role: "system", content: systemPrompt }];
    
    // 6. 触发第一轮
    processGameTurn("游戏开始，进入第一夜", true); // 强制第一步为手动推动流程
}

function createComplexSystemPrompt(user) {
    const playersInfo = gameState.players.map(p => {
        let status = p.alive ? '存活' : '出局';
        if (p.isIdiotFlipped) status = '白痴翻牌(无投票)';
        return `${p.id}号:${p.role} (${status}) ${p.isUser ? '(你)' : ''}`;
    }).join('; ');
    
    const wolfPartners = gameState.players.filter(p => p.role === '狼人').map(p => p.id);

    return `
    你是一个中国古风狼人杀游戏的【法官】兼【所有AI玩家】的大脑。
    背景：深宅大院，迷雾重重，局势诡谲。
    
    【游戏配置】
    板子：12人局 (4狼人, 4村民, 预言家, 女巫, 猎人, 白痴)。
    用户是 ${user.id} 号玩家，身份是 ${user.role}。
    
    【玩家真实底牌】(只有法官和狼人团队知晓):
    ${playersInfo}

    【获胜条件】
    好人方 (村民+神民) 获胜：所有狼人出局。
    狼人方 获胜：屠边制，杀死所有神民 或所有村民出局。

    【核心规则总结】
    - 警长：拥有1.5票，可决定发言顺序，警徽可移交。
    - 女巫：全程不可自救，解药和毒药不能同晚使用，解药用完不告知死讯。女巫状态：解药${user.role === '女巫' && user.hasAntidote ? '有' : '无'}, 毒药${user.role === '女巫' && user.hasPoison ? '有' : '无'}。
    - 猎人：被刀死或公投出局可翻牌带人（女巫毒死除外）。
    - 白痴：被公投出局可翻牌留场发言但无投票权。
    - 狼人：夜间击杀一人，白天可自爆跳过所有环节直接天黑（有30s遗言或夜间指刀二选一）。
    
    【游戏流程指导】
    夜晚流程：(1)狼人行动 -> (2)女巫行动 -> (3)预言家行动 -> (4)猎人/白痴确认。
    白天流程：(1)宣布死讯 -> (2)警长竞选 (第1/2天) -> (3)发言 -> (4)投票放逐 -> (5)出局者留遗言/猎人开枪。
    
    【***关键指令：信息隔离与法官主持优化***】
    1. **私密信息 (Night Actions, Reasons for Actions):**
       - 狼人击杀目标、女巫用药目标及理由、预言家查验目标及结果，以及AI玩家的内心动机和决策过程，**必须且只能**出现在 JSON 的 **"thought"** 字段中。
       - **绝对禁止**将这些私密信息（例如：“狼人刀了5号”、“女巫决定不救”、“预言家验出6号是好人”）写入 **"judge_speak"**, **"ai_speak"**, 或 **"game_event"** 字段。
    2. **公开信息 (Judge Narration):**
       - **"judge_speak"** 仅能包含：流程引导 (如 “天黑请闭眼”, “天亮了”) 和公开结果 (如 “昨夜平安夜/有人出局”, “X号玩家出局”)。
       - **移除所有**关于游戏机制的 **“手势”、“编号提示”** 等元指令。法官应使用**自然语言**进行引导（例如，指导女巫环节：“女巫请睁眼，昨夜X号玩家被击杀。请选择是否使用解药或毒药，目标请点击号码，弃用请点击放弃按钮”）。
    3. **AI玩家发言**：AI玩家的发言内容（"ai_speak"）必须符合其当前角色身份和游戏阶段，**绝不能**透露底牌或夜间信息。
    
    【输出格式】
    你必须只返回一个 JSON 对象，不要Markdown。
    {
        "thought": "简短的思维链，决定下一步做什么。**包含所有AI的夜间行动和私密决策理由。**",
        "judge_speak": "法官的主持台词，如果没有则为空字符串。**只包含流程引导和公开结果。**",
        "ai_speak": { "seat_id": 3, "content": "3号玩家的发言内容" } (如果没有AI发言则为null),
        "game_event": "描述发生了什么，例如 '5号死亡', '警长被投出', '警徽流失'。**只包含公开宣布的结果。**",
        "current_phase": "当前游戏阶段（如 Night1, Day1, SheriffElection）",
        "targets": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] (在行动或投票阶段，列出当前存活且可被操作的玩家ID),
        "next_phase": "下一步阶段：'user_turn', 'vote', 'kill_target', 'seer_check', 'witch_action', 'game_over', 'wait_for_next_step'"
    }
    
    现在游戏开始，请输出第一夜的开场词，并让用户手动推动流程。
    `;
}

function renderSeats() {
    const container = document.getElementById('seats-area');
    container.innerHTML = '';
    gameState.players.forEach(p => {
        let div = document.createElement('div');
        div.className = `seat ${p.isUser ? 'user' : ''}`;
        div.id = `seat-${p.id}`;
        // 显示警长标记
        let sheriffMark = p.id === gameState.sheriff ? ' (警)' : '';
        // 显示技能状态
        let skillStatus = '';
        if (p.role === '女巫') {
            skillStatus += p.hasAntidote ? ' [解]' : '';
            skillStatus += p.hasPoison ? ' [毒]' : '';
        }
        div.innerText = `${p.id}号 ${p.isUser ? '(你)' : ''}${sheriffMark}${skillStatus}`;
        
        // 标记出局玩家
        if (!p.alive) {
            div.style.textDecoration = 'line-through';
            div.style.opacity = '0.5';
            div.title = "已出局";
        }
        // 标记白痴翻牌玩家
        if (p.isIdiotFlipped) {
             div.style.border = '2px dashed #bfa46f'; // 白痴标记
             div.title = "白痴已翻牌，无投票权";
        }
        
        container.appendChild(div);
    });
}

// ====== AI 核心交互 ======
async function processGameTurn(userActionDescription, initial = false) {
    if (gameState.isProcessing) return;
    gameState.isProcessing = true;
    updateStatus("天机推演中...");
    
    // 隐藏所有流程控制按钮
    setFlowControlButtons('hidden');
    actionButtonsArea.innerHTML = '';

    // 添加用户动作到历史
    if (!initial) {
        gameState.history.push({ role: "user", content: userActionDescription });
    }

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
        // Clean up JSON response
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
        if (aiResult.ai_speak && aiResult.ai_speak.content) {
            highlightSeat(aiResult.ai_speak.seat_id);
            addLog("ai", `${aiResult.ai_speak.seat_id}号: ${aiResult.ai_speak.content}`);
            await speakText(`${aiResult.ai_speak.seat_id}号说: ${aiResult.ai_speak.content}`);
            unhighlightSeat(aiResult.ai_speak.seat_id);
        }
        
        // 3. 处理游戏事件（如死亡，警长变更）
        if (aiResult.game_event) {
            // NOTE: game_event 应该只包含公开信息，如 "5号死亡"
            addLog("system-important", `【事件】 ${aiResult.game_event}`);
            
            // 每次宣布事件后，需要更新UI
            renderSeats(); 
        }

        // 4. 处理用户行动阶段
        const nextPhase = aiResult.next_phase;
        
        if (nextPhase === "user_turn") {
            // 提示用户可以自由发言 (显示麦克风)
            setFlowControlButtons('mic');
            updateStatus(`【${aiResult.current_phase}】轮到你(${gameState.players[gameState.userIndex].id}号)发言`);
        } else if (nextPhase === "wait_for_next_step") {
            // 提示用户点击下一步推动流程 (显示下一步按钮)
            setFlowControlButtons('next');
            updateStatus(`【${aiResult.current_phase}】请点击下一步继续游戏流程`);
        } else if (['kill_target', 'seer_check', 'witch_action', 'vote', 'sheriff_vote'].includes(nextPhase)) {
            // 提示用户需要点击按钮进行技能操作或投票 (显示技能按钮)
            renderUserActionButtons(nextPhase, aiResult.targets || []);
            setFlowControlButtons('action'); // 隐藏麦克风和下一步
            updateStatus(`【${aiResult.current_phase}】轮到你行动`);
        } else if (nextPhase === "game_over") {
            setFlowControlButtons('hidden');
            updateStatus("游戏结束！");
            addLog("judge", "游戏结束，请查看胜负结果！", "system-important");
        } else {
            // 兜底：如果 AI 返回了未知的 next_phase，强制推动下一步
            setFlowControlButtons('next');
            updateStatus("【未知阶段】请点击下一步继续流程");
        }

    } catch (e) {
        console.error("游戏回合处理失败:", e);
        // Log the raw AI response for debugging if possible
        if(data) console.error("Raw AI Response:", JSON.stringify(data, null, 2));

        addLog("system-important", `致命错误，请查看控制台。AI/网络错误信息: ${e.message}`);
        setFlowControlButtons('next'); // 允许用户点击下一步来尝试恢复流程
    } finally {
        gameState.isProcessing = false;
    }
}

// ====== 流程控制按钮处理 ======

function handleNextStep() {
    // 点击下一步按钮，向AI发送信号，要求继续流程
    if (!gameState.isProcessing) {
        processGameTurn(MANUAL_PUSH_PROMPT);
    }
}

function setFlowControlButtons(mode) {
    micBtn.classList.add('hidden');
    nextStepBtn.classList.add('hidden');
    actionBar.classList.remove('user-turn');
    actionBar.classList.remove('flow-push');
    
    if (mode === 'mic') {
        micBtn.classList.remove('hidden');
        actionBar.classList.add('user-turn');
        micBtn.disabled = false;
    } else if (mode === 'next') {
        nextStepBtn.classList.remove('hidden');
        actionBar.classList.add('flow-push');
    }
    // 'action' 模式由 renderUserActionButtons 处理，这里只需隐藏 mic/next
}

// ====== 语音转文字 (STT) - Web Speech API ======
let recognition;

if ('webkitSpeechRecognition' in window) {
    recognition = new webkitSpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    
    micBtn.onmousedown = () => {
        if (!micBtn.disabled && !gameState.isProcessing) {
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
        addLog("user", `你(${gameState.players[gameState.userIndex].id}号)发言: ${text}`);
        // 将用户的话发给 AI
        processGameTurn(`用户(${gameState.players[gameState.userIndex].id}号)发言: "${text}"`);
    };
} else {
    // 默认行为：如果不支持语音，用户发言等同于点击下一步
    micBtn.innerText = "浏览器不支持语音";
    micBtn.disabled = true;
    micBtn.title = "请使用支持Web Speech API的浏览器";
}

// ====== 语音合成 (TTS) ======
function initTTS() {
    // Ensure voices are loaded before trying to use them
    if (window.speechSynthesis.getVoices().length === 0) {
        window.speechSynthesis.onvoiceschanged = () => {
            console.log("TTS voices loaded.");
        };
    }
    window.speechSynthesis.cancel();
}

function speakText(text) {
    return new Promise((resolve) => {
        if (!text) return resolve();
        
        // Prevent empty or very short strings from blocking
        if (text.trim().length < 2) return resolve();
        
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = 1.0; 
        
        let voices = window.speechSynthesis.getVoices();
        let zhVoice = voices.find(v => v.lang.includes('zh'));
        if (zhVoice) u.voice = zhVoice;

        u.onend = resolve;
        u.onerror = (e) => {
            console.error("TTS Error:", e);
            resolve(); // Resolve even on error to unblock the flow
        };
        
        window.speechSynthesis.speak(u);
    });
}

// ====== 动态按钮渲染和事件处理 ======

function renderUserActionButtons(phase, targets) {
    actionButtonsArea.innerHTML = '';
    const user = gameState.players[gameState.userIndex];
    
    // 隐藏流程按钮，只显示操作按钮
    setFlowControlButtons('hidden');

    let buttonTitle = '选择行动目标';
    let actionType = phase; // 使用 phase 作为行动类型
    let showSkip = true;

    // 根据阶段和身份确定行动类型和提示
    if (phase === 'kill_target' && user.role === '狼人') {
        buttonTitle = '狼人请选择击杀目标';
    } else if (phase === 'seer_check' && user.role === '预言家') {
        buttonTitle = '预言家请验人';
        // 预言家必须验人，不能跳过
        showSkip = false; 
    } else if (phase === 'witch_action' && user.role === '女巫') {
        buttonTitle = '女巫请选择目标（或选择放弃）';
        // 女巫可以弃用
        showSkip = true; 
    } else if (phase === 'vote' || phase === 'sheriff_vote') {
        buttonTitle = '请投出你的放逐/警长票';
        // 投票可以弃票
        showSkip = true; 
    }
    
    // 确保只显示存活的玩家作为目标，并且是AI提供的targets列表中的玩家
    const availableTargets = gameState.players
        .filter(p => p.alive && targets.includes(p.id))
        // 确保不能选择自己，除非是特殊情况（如自爆，但自爆是独立按钮）
        .filter(p => p.id !== user.id) 
        .map(p => p.id);

    addLog("system-important", `【${buttonTitle}】请点击选择座位号。`);

    // 渲染目标按钮
    availableTargets.forEach(targetId => {
        let btn = document.createElement('button');
        btn.className = 'ink-btn action-target-btn';
        btn.innerText = `${targetId}号`;
        
        btn.onclick = () => {
            // 禁用所有按钮，防止重复点击
            document.querySelectorAll('.action-target-btn').forEach(b => b.disabled = true);
            
            // 构建发送给 AI 的行动文本
            let actionText = `${user.role}(${user.id}号)执行了[${actionType}]行动，目标是 ${targetId}号`;
            
            actionButtonsArea.innerHTML = ''; // 清空按钮区
            processGameTurn(actionText); 
        };
        actionButtonsArea.appendChild(btn);
    });
    
    // 提供一个“放弃”按钮或弃票选项
    if (showSkip) {
        let skipBtn = document.createElement('button');
        skipBtn.className = 'ink-btn action-target-btn';
        // 根据阶段显示不同的放弃文本
        skipBtn.innerText = (phase === 'vote' || phase === 'sheriff_vote') ? '弃票' : '放弃行动';
        skipBtn.onclick = () => {
             document.querySelectorAll('.action-target-btn').forEach(b => b.disabled = true);
             processGameTurn(`${user.role}(${user.id}号)选择了弃权/放弃行动`);
             actionButtonsArea.innerHTML = '';
        };
        actionButtonsArea.appendChild(skipBtn);
    }
    
    // 特殊行动：狼人自爆
    if (user.role === '狼人' && (phase === 'vote' || phase === 'user_turn')) {
        let selfDestructBtn = document.createElement('button');
        selfDestructBtn.className = 'ink-btn action-target-btn';
        selfDestructBtn.style.backgroundColor = '#5c1b1b';
        selfDestructBtn.innerText = '狼人自爆';
        selfDestructBtn.onclick = () => {
             document.querySelectorAll('.action-target-btn').forEach(b => b.disabled = true);
             processGameTurn(`狼人(${user.id}号)选择自爆`);
             actionButtonsArea.innerHTML = '';
        };
        actionButtonsArea.appendChild(selfDestructBtn);
    }
}

// ====== 辅助 UI 函数 ======

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

const Utility = {
    // 确保随机选一个活着的玩家，避免直接返回-1
    getRandomAlivePlayerIndex: (max) => {
        let index = Math.floor(Math.random() * max);
        if (gameState.players.length > 0) {
            // 简单的检查是否存活，虽然在初始化时所有人都活
            if (gameState.players[index].alive) return index;
        }
        return index;
    }
}

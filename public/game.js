// public/game.js - 核心游戏逻辑，集成语音输入和AI遗言

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

/**
 * 游戏开始的初始化流程
 */
function startGame() {
    // 1. 初始化音频上下文
    initTTS(); 
    
    // 2. 分配角色
    let shuffled = [...ROLES].sort(() => Math.random() - 0.5);
    // 确保用户身份是1到12号玩家之一
    gameState.userIndex = Math.floor(Math.random() * shuffled.length); 
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

/**
 * 创建包含所有游戏规则和AI指令的系统提示。
 * @param {object} user - 用户玩家对象。
 * @returns {string} 完整的系统提示文本。
 */
function createComplexSystemPrompt(user) {
    const playersInfo = gameState.players.map(p => {
        let status = p.alive ? '存活' : '出局';
        if (p.isIdiotFlipped) status = '白痴翻牌(无投票)';
        return `${p.id}号:${p.role} (${status}) ${p.isUser ? '(你)' : ''}`;
    }).join('; ');
    
    return `
    你是一个中国古风狼人杀游戏的【法官】兼【所有AI玩家】的大脑。
    背景：深宅大院，迷雾重重，局势诡谲。
    
    【游戏配置】
    板子：12人局 (4狼人, 4村民, 预言家, 女巫, 猎人, 白痴)。
    用户是 ${user.id} 号玩家，身份是 ${user.role}。
    
    【玩家真实底牌】(只有法官和狼人团队知晓):
    ${playersInfo}

    【核心规则总结】
    - 警长：拥有1.5票，可决定发言顺序，警徽可移交。
    - 女巫：全程不可自救，解药和毒药不能同晚使用。女巫状态：解药${user.role === '女巫' && user.hasAntidote ? '有' : '无'}, 毒药${user.role === '女巫' && user.hasPoison ? '有' : '无'}。
    - 猎人：被刀死或公投出局可翻牌带人（女巫毒死除外）。
    
    【游戏流程指导】
    夜晚流程：(1)狼人行动 -> (2)女巫行动 -> (3)预言家行动。
    白天流程：(1)宣布死讯 -> (2)警长竞选/发言顺序确定 -> (3)发言 -> (4)投票放逐 -> (5)出局者留遗言/猎人开枪。
    
    【***关键指令：信息隔离与法官主持优化***】
    1. **私密信息 (Night Actions, Reasons for Actions):**
       - 狼人击杀目标、女巫用药目标及理由、预言家查验目标及结果，以及AI玩家的内心动机和决策过程，**必须且只能**出现在 JSON 的 **"thought"** 字段中。
       - **绝对禁止**将这些私密信息（例如：“狼人刀了5号”、“预言家验出6号是好人”）写入 **"judge_speak"**, **"ai_speak"**, 或 **"game_event"** 字段。
       
    2. **公开信息 (Judge Narration) 与特殊角色信息传递：**
       - **"judge_speak"** 仅能包含：流程引导 (如 “天黑请闭眼”, “天亮了”) 和公开结果 (如 “昨夜平安夜/有人出局”, “X号玩家出局”)。
       - **对女巫的信息 (如果用户是女巫):** 在女巫行动阶段，你必须在 **"judge_speak"** 中明确告诉玩家昨夜被击杀的目标ID。例如："法官请示女巫，昨夜被击杀的是X号玩家，您是否使用解药？"
       - **对预言家的信息 (如果用户是预言家):** 在预言家行动后，你必须在下一个回合的 **"judge_speak"** 中私下告诉用户查验的真实结果（是好人/狼人）。例如："法官向预言家耳语：你查验的X号玩家是好人。"
       
    3. **AI 玩家遗言 (Yíyán) 强制要求:** 当有玩家出局时（无论是夜间被击杀还是白天被公投），法官宣布死讯/投票结果后，**如果该玩家是AI**，你必须在接下来的输出中将该玩家的遗言放入 "ai_speak" 字段。遗言内容应符合其身份，且不得透露底牌。
    
    4. **AI玩家发言**：AI玩家的发言内容（"ai_speak"）必须符合其当前角色身份和游戏阶段。
    
    【输出格式】
    你必须只返回一个 JSON 对象，不要Markdown。
    {
        "thought": "简短的思维链，决定下一步做什么。**包含所有AI的夜间行动和私密决策理由。**",
        "judge_speak": "法官的主持台词，如果没有则为空字符串。",
        "ai_speak": { "seat_id": 3, "content": "3号玩家的发言内容或遗言" } (如果没有AI发言则为null),
        "game_event": "描述发生了什么，例如 '5号死亡', '警长被投出'。**只包含公开宣布的结果。**",
        "current_phase": "当前游戏阶段（如 Night1, Day1, SheriffElection, Day1_Speech）",
        "targets": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] (在行动或投票阶段，列出当前存活且可被操作的玩家ID),
        "next_phase": "下一步阶段：'user_turn', 'vote', 'kill_target', 'seer_check', 'witch_action', 'game_over', 'wait_for_next_step'"
    }
    
    现在游戏开始，请输出第一夜的开场词，并让用户手动推动流程。
    `;
}

/**
 * 渲染玩家座位和状态
 */
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
/**
 * 处理一轮游戏逻辑，与AI进行通信
 * @param {string} userActionDescription - 玩家的行动描述或发言内容
 * @param {boolean} initial - 是否是游戏开始的初始调用
 */
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

        // 2. AI 玩家说话或遗言 (重点：语音播放)
        if (aiResult.ai_speak && aiResult.ai_speak.content) {
            const seatId = aiResult.ai_speak.seat_id;
            const content = aiResult.ai_speak.content;
            
            highlightSeat(seatId);
            addLog("ai", `${seatId}号: ${content}`);
            // 播放 AI 玩家的发言或遗言
            await speakText(`${seatId}号说: ${content}`);
            unhighlightSeat(seatId);
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
        const user = gameState.players[gameState.userIndex];
        // 玩家必须存活且不是已翻牌的白痴才能有发言和投票权
        const userIsActive = user.alive && !user.isIdiotFlipped; 

        // 检查是否是夜晚行动阶段，并且当前玩家不是该行动的角色，如果是，则自动推进。
        if (nextPhase === 'kill_target' && aiResult.current_phase.startsWith('Night') && (!userIsActive || user.role !== '狼人')) {
            updateStatus(`【${aiResult.current_phase}】您不是狼人，自动跳过...`);
            setTimeout(() => processGameTurn(MANUAL_PUSH_PROMPT), 1500);
        } else if (nextPhase === 'witch_action' && aiResult.current_phase.startsWith('Night') && (!userIsActive || user.role !== '女巫')) {
            updateStatus(`【${aiResult.current_phase}】您不是女巫，自动跳过...`);
            setTimeout(() => processGameTurn(MANUAL_PUSH_PROMPT), 1500);
        } else if (nextPhase === 'seer_check' && aiResult.current_phase.startsWith('Night') && (!userIsActive || user.role !== '预言家')) {
            updateStatus(`【${aiResult.current_phase}】您不是预言家，自动跳过...`);
            setTimeout(() => processGameTurn(MANUAL_PUSH_PROMPT), 1500);
        } 
        // 检查用户是否需要进行主动操作
        else if (nextPhase === 'kill_target' && userIsActive && user.role === '狼人') {
            renderUserActionButtons(nextPhase, aiResult.targets || []);
            setFlowControlButtons('action'); 
            updateStatus(`【${aiResult.current_phase}】狼人请选择击杀目标`);
        } else if (nextPhase === 'witch_action' && userIsActive && user.role === '女巫') {
            renderUserActionButtons(nextPhase, aiResult.targets || []);
            setFlowControlButtons('action'); 
            updateStatus(`【${aiResult.current_phase}】女巫请选择是否用药`);
        } else if (nextPhase === 'seer_check' && userIsActive && user.role === '预言家') {
            renderUserActionButtons(nextPhase, aiResult.targets || []);
            setFlowControlButtons('action'); 
            updateStatus(`【${aiResult.current_phase}】预言家请选择查验目标`);
        } else if (nextPhase === "user_turn" && userIsActive) {
            // 白天发言阶段：显示麦克风按钮
            setFlowControlButtons('mic');
            updateStatus(`【${aiResult.current_phase}】轮到你(${user.id}号)发言`);
        } else if (['vote', 'sheriff_vote'].includes(nextPhase) && userIsActive) {
            // 白天投票阶段：显示投票按钮
            renderUserActionButtons(nextPhase, aiResult.targets || []);
            setFlowControlButtons('action');
            updateStatus(`【${aiResult.current_phase}】轮到你(${user.id}号)投票`);
        } else if (nextPhase === "user_turn" && !userIsActive) {
            // 白天发言阶段，但玩家已出局或无投票权，自动跳过
            updateStatus(`【${aiResult.current_phase}】您已出局或无投票权，自动跳过发言...`);
            setTimeout(() => processGameTurn(MANUAL_PUSH_PROMPT), 1500);
        } else if (['vote', 'sheriff_vote'].includes(nextPhase) && !userIsActive) {
            // 白天投票阶段，但玩家已出局或无投票权，自动跳过
            updateStatus(`【${aiResult.current_phase}】您已出局或无投票权，自动跳过投票...`);
            setTimeout(() => processGameTurn(MANUAL_PUSH_PROMPT), 1000);
        } else if (nextPhase === "wait_for_next_step") {
            // 法官主持完毕，等待用户点击下一步
            setFlowControlButtons('next');
            updateStatus(`【${aiResult.current_phase}】法官主持中，请点击下一步继续`);
        } else if (nextPhase === "game_over") {
            setFlowControlButtons('hidden');
            updateStatus("游戏结束！");
            addLog("judge", "游戏结束，请查看胜负结果！", "system-important");
        } else {
            // 兜底：未知状态或流程推进
            setFlowControlButtons('next');
            updateStatus("【流程推进】请点击下一步继续流程");
        }

    } catch (e) {
        console.error("游戏回合处理失败:", e);
        const errorData = data ? JSON.stringify(data, null, 2) : "No data available";
        console.error("Raw AI Response:", errorData);

        addLog("system-important", `致命错误，请查看控制台。AI/网络错误信息: ${e.message}`);
        setFlowControlButtons('next'); // 允许用户点击下一步来尝试恢复流程
    } finally {
        gameState.isProcessing = false;
    }
}

// ====== 流程控制按钮处理 ======

/**
 * 处理用户点击“下一步”按钮
 */
function handleNextStep() {
    // 点击下一步按钮，向AI发送信号，要求继续流程
    if (!gameState.isProcessing) {
        processGameTurn(MANUAL_PUSH_PROMPT);
    }
}

/**
 * 控制流程控制区域（麦克风/下一步）的显示模式
 * @param {'hidden'|'mic'|'next'|'action'} mode - 显示模式
 */
function setFlowControlButtons(mode) {
    micBtn.classList.add('hidden');
    nextStepBtn.classList.add('hidden');
    actionBar.classList.remove('user-turn');
    actionBar.classList.remove('flow-push');
    
    if (mode === 'mic') {
        micBtn.classList.remove('hidden');
        actionBar.classList.add('user-turn');
        micBtn.disabled = false;
        micBtn.innerText = "按住说话"; // 确保状态正确
    } else if (mode === 'next') {
        nextStepBtn.classList.remove('hidden');
        actionBar.classList.add('flow-push');
    }
    // 'action' 模式由 renderUserActionButtons 处理，这里只需隐藏 mic/next
}

// ====== 语音转文字 (STT) - Web Speech API (用户发言) ======
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
        // 将用户的话发给 AI，作为游戏中的真实发言内容
        processGameTurn(`用户(${gameState.players[gameState.userIndex].id}号)发言: "${text}"`);
    };

    recognition.onerror = (event) => {
        micBtn.innerText = "按住说话";
        micBtn.style.background = "";
        console.error("STT Error:", event.error);
        if (event.error !== 'no-speech') {
            addLog("system-important", `语音识别错误: ${event.error}。请重试。`);
        }
    };
    
} else {
    // 如果浏览器不支持语音输入，则退回到文本输入模式（此环境暂无法支持复杂文本输入，故禁用STT，提示用户）
    micBtn.innerText = "浏览器不支持语音";
    micBtn.disabled = true;
    micBtn.title = "请使用支持Web Speech API的浏览器";
}

// ====== 语音合成 (TTS) - AI 法官主持和AI玩家遗言 ======
/**
 * 初始化 TTS
 */
function initTTS() {
    if (window.speechSynthesis.getVoices().length === 0) {
        window.speechSynthesis.onvoiceschanged = () => {
            console.log("TTS voices loaded.");
        };
    }
    window.speechSynthesis.cancel();
}

/**
 * 播放文本语音
 * @param {string} text - 需要播放的文本
 * @returns {Promise<void>}
 */
function speakText(text) {
    return new Promise((resolve) => {
        if (!text || text.trim().length < 2) return resolve();
        
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

// ====== 女巫 UI 辅助函数 (实现分步的 "是/否" 简化操作) ======

/**
 * 渲染女巫毒药目标选择按钮
 * @param {string} antidoteResult - 包含解药结果的行动描述，用于拼接最终行动
 */
function renderPoisonTargetButtons(antidoteResult) {
    const user = gameState.players[gameState.userIndex];
    actionButtonsArea.innerHTML = ''; // 清空按钮
    
    // 毒药目标是所有存活玩家（除了自己）
    const poisonTargets = gameState.players
        .filter(p => p.alive && p.id !== user.id) 
        .map(p => p.id);
        
    addLog("system-important", "【毒药目标】请选择毒药目标（点击座位号）。");
        
    poisonTargets.forEach(targetId => {
        let btn = document.createElement('button');
        btn.className = 'ink-btn action-target-btn';
        btn.innerText = `${targetId}号`;
        
        btn.onclick = () => {
            document.querySelectorAll('.action-target-btn').forEach(b => b.disabled = true);
            
            // 最终行动：解药结果 + 毒药目标
            const finalAction = antidoteResult + `, 毒药目标是 ${targetId}号`;
            actionButtonsArea.innerHTML = '';
            processGameTurn(finalAction);
        };
        actionButtonsArea.appendChild(btn);
    });
}

/**
 * 渲染女巫行动UI：分步处理解药和毒药
 * @param {number[]} targets - 包含昨夜被狼人击杀的目标ID (如果有)
 */
function renderWitchActionUI(targets) {
    const user = gameState.players[gameState.userIndex];
    // targets[0] 期望是昨夜被击杀的目标ID
    const killedTargetId = targets.length > 0 ? targets[0] : null; 
    
    const statusText = `女巫状态：解药${user.hasAntidote ? '有' : '无'}, 毒药${user.hasPoison ? '有' : '无'}。`;
    actionButtonsArea.innerHTML = `<div class="status-tip">${statusText}</div>`;
    
    // --- Step 2: Poison Decision (在解药决定后调用) ---
    const renderPoisonDecisionUI = (antidoteResult) => {
        actionButtonsArea.innerHTML = `<div class="status-tip">${statusText}</div>`;
        
        if (!user.hasPoison) {
            // 毒药已用完，直接结束行动
            addLog("system-important", "【女巫行动】您的毒药已用完，行动结束。");
            const finalAction = antidoteResult + ", 毒药已用完";
            actionButtonsArea.innerHTML = '';
            processGameTurn(finalAction);
            return;
        }
        
        // 1. 提示使用毒药
        addLog("system-important", `【女巫行动 - 毒药】现在请选择是否使用毒药。`);
        
        // 2. 毒药 "是" 按钮 (进入目标选择)
        const yesBtn = document.createElement('button');
        yesBtn.className = 'ink-btn action-target-btn';
        yesBtn.innerText = '是 (使用毒药)';
        yesBtn.onclick = () => {
             // 进入目标选择 UI
             renderPoisonTargetButtons(antidoteResult); 
        };
        actionButtonsArea.appendChild(yesBtn);
        
        // 3. 毒药 "否" 按钮 (结束行动)
        const noBtn = document.createElement('button');
        noBtn.className = 'ink-btn action-target-btn';
        noBtn.innerText = '否 (放弃毒药)';
        noBtn.onclick = () => {
            // 最终行动：解药结果 + 毒药"未用"
            const finalAction = antidoteResult + ", 毒药未用";
            actionButtonsArea.innerHTML = '';
            processGameTurn(finalAction);
        };
        actionButtonsArea.appendChild(noBtn);
    };


    // === Step 1: Antidote Decision ===
    if (user.hasAntidote) {
        if (killedTargetId) {
            // 狼人有目标，提示女巫救人
            addLog("system-important", `【女巫行动 - 解药】昨夜 ${killedTargetId} 号玩家被狼人击杀，请选择是否使用解药救治。`);
            
            let yesBtn = document.createElement('button');
            yesBtn.className = 'ink-btn action-target-btn';
            yesBtn.innerText = '是 (救他)';
            // 注意：这里需要更新玩家状态，但在JS中我们不直接操作gameState.players，而是让AI来根据行动文本更新状态。
            yesBtn.onclick = () => renderPoisonDecisionUI(`${user.role}(${user.id}号)执行了[witch_action]行动: 解药救了 ${killedTargetId}号`);
            actionButtonsArea.appendChild(yesBtn);

            let noBtn = document.createElement('button');
            noBtn.className = 'ink-btn action-target-btn';
            noBtn.innerText = '否 (不救)';
            noBtn.onclick = () => renderPoisonDecisionUI(`${user.role}(${user.id}号)执行了[witch_action]行动: 解药未用`);
            actionButtonsArea.appendChild(noBtn);
            
        } else {
            // 平安夜，无法使用解药
            addLog("system-important", "【女巫行动 - 解药】昨夜平安夜，无法使用解药。");
            renderPoisonDecisionUI(`${user.role}(${user.id}号)执行了[witch_action]行动: 解药无法使用(平安夜)`);
        }
    } else {
        // 解药已用完，直接跳过到毒药决策
        addLog("system-important", "【女巫行动 - 解药】您的解药已用完。");
        renderPoisonDecisionUI(`${user.role}(${user.id}号)执行了[witch_action]行动: 解药已用完`);
    }
}

// ====== 动态按钮渲染和事件处理 ======

/**
 * 渲染用户技能操作按钮
 * @param {string} phase - 当前阶段 (kill_target, seer_check, vote, etc.)
 * @param {number[]} targets - 可操作的目标玩家ID列表
 */
function renderUserActionButtons(phase, targets) {
    actionButtonsArea.innerHTML = '';
    const user = gameState.players[gameState.userIndex];
    
    // 隐藏流程按钮，只显示操作按钮
    setFlowControlButtons('hidden');

    // === 女巫逻辑分支：调用新的分步 UI ===
    if (phase === 'witch_action' && user.role === '女巫') {
        renderWitchActionUI(targets); 
        return; // 女巫逻辑已完成，退出
    }
    // ====================================
    
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

/**
 * 添加流程日志，并自动滚动到底部
 * @param {string} type - 日志类型 (judge, user, ai, system, system-important)
 * @param {string} text - 日志内容
 */
function addLog(type, text) {
    let div = document.createElement('div');
    // 使用 type 参数来处理 system-important 样式
    div.className = `msg ${type}`;
    div.innerText = text;
    storyLog.appendChild(div);
    // 实现滚动条拉到最底部
    storyLog.scrollTop = storyLog.scrollHeight; 
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

const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// 路由设置：直接读取根目录下的 index.html
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});
app.use(express.static(__dirname));

// 144 字库
const uniqueChars = [
    "我", "你", "他", "她", "它", "们", "是", "不", "了", "在", "有", "和", "去", "好", "这", "那",
    "的", "地", "得", "着", "过", "爱", "想", "说", "看", "听", "写", "做", "打", "开", "关", "心",
    "人", "生", "活", "死", "光", "暗", "风", "花", "雪", "月", "春", "夏", "秋", "冬", "天", "日",
    "星", "辰", "山", "海", "红", "黄", "蓝", "白", "黑", "绿", "色", "空", "梦", "魂", "灵", "神", "鬼",
    "怪", "家", "城", "路", "远", "近", "高", "低", "大", "小", "多", "少", "美", "丑", "真", "假", "善",
    "恶", "喜", "怒", "哀", "乐", "酸", "甜", "苦", "辣", "醉", "醒", "迷", "悟", "离", "合", "聚", "散",
    "知", "识", "岁", "流", "年", "古", "今", "未", "来", "希", "望", "绝", "对", "可", "能", "因", "为",
    "但", "如", "果", "只", "要", "就", "才", "会", "快", "慢", "冷", "热", "痛", "痒", "麻", "疯", "狂",
    "笑", "哭", "喊", "叫", "沉", "默", "孤", "独", "自", "由", "夜", "晚", "早", "晨", "睡", "眠", "床", "窗",
    "野", "兽", "吻", "杀", "欲", "念", "虚", "妄", "尘", "埃", "无", "边", "界", "网", "络"
];

const BOT_NAMES = ["阿法狗", "深蓝", "人工智障", "ChatGPT", "Sora"];

// 房间存储
let rooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 加入房间
    socket.on('joinRoom', ({ roomId, playerName, targetCount, gameMode }) => {
        socket.join(roomId);

        // 如果房间不存在，创建新房间
        if (!rooms[roomId]) {
            rooms[roomId] = {
                mode: gameMode || 1, 
                players: [],
                deck: [],
                discardPile: [],
                turnIndex: 0,
                state: 'WAITING',
                lastDiscard: null,
                maxPlayers: targetCount || 4 
            };
        } else {
            const room = rooms[roomId];
            if (room.state === 'WAITING') {
                if (targetCount) room.maxPlayers = targetCount;
                if (gameMode) room.mode = gameMode;
            }
        }

        const room = rooms[roomId];

        if (room.state === 'PLAYING' && room.mode !== gameMode) {
            socket.emit('errorMsg', '该房间正在进行另一种模式的游戏！');
            return;
        }

        // --- 1. 单人模式 (PvE) ---
        if (room.maxPlayers === 1) {
            if (room.mode !== 1) {
                socket.emit('errorMsg', '只有基础玩法支持单人模式');
                return;
            }
            if (room.players.length > 0) {
                const p = room.players.find(p => !p.isBot);
                if (p) {
                    p.id = socket.id; 
                    p.name = playerName;
                    socket.emit('joined', { seat: p.seat, maxPlayers: 4, mode: room.mode });
                    io.to(roomId).emit('updatePlayers', room.players);
                    if (room.state === 'PLAYING') socket.emit('gameStart', sanitizeState(room));
                    return;
                }
            }
            room.players = [];
            room.players.push({ id: socket.id, name: playerName, hand: [], seat: 0, isReady: true, isBot: false });
            for(let i=1; i<=3; i++) {
                room.players.push({
                    id: `bot_${roomId}_${i}`,
                    name: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + (i),
                    hand: [], seat: i, isReady: true, isBot: true
                });
            }
            room.maxPlayers = 4; 
            socket.emit('joined', { seat: 0, maxPlayers: 4, mode: room.mode });
            io.to(roomId).emit('updatePlayers', room.players);
            startGame(roomId);
            return;
        }

        // --- 2. 多人模式 (PvP) ---
        const existingPlayer = room.players.find(p => p.id === socket.id);
        if (existingPlayer) {
            existingPlayer.name = playerName;
            socket.emit('joined', { seat: existingPlayer.seat, maxPlayers: room.maxPlayers, mode: room.mode });
            io.to(roomId).emit('updatePlayers', room.players);
            if (room.state === 'PLAYING') socket.emit('gameStart', sanitizeState(room));
            return;
        }

        if (room.players.length < room.maxPlayers) {
            if (room.state === 'PLAYING') {
                 socket.emit('errorMsg', '游戏进行中');
                 return;
            }
            const seat = room.players.length;
            room.players.push({ 
                id: socket.id, name: playerName || `玩家${seat+1}`, 
                hand: [], seat: seat, isReady: false, isBot: false 
            });
            socket.emit('joined', { seat: seat, roomId: roomId, maxPlayers: room.maxPlayers, mode: room.mode });
            io.to(roomId).emit('updatePlayers', room.players);
        } else {
            socket.emit('errorMsg', '房间已满');
        }
    });

    socket.on('ready', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.isReady = true;
        io.to(roomId).emit('updatePlayers', room.players);

        if (room.players.length === room.maxPlayers && room.players.every(p => p.isReady)) {
            startGame(roomId);
        }
    });

    // --- 摸牌 ---
    socket.on('drawCard', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const p = room.players[room.turnIndex];
        if (p.isBot || p.id !== socket.id) return;

        if (room.deck.length === 0) { 
            if (room.mode === 3) {
                endNoLimitGame(roomId);
                return;
            } else {
                io.to(roomId).emit('gameLog', '流局'); 
                return; 
            }
        }

        const card = room.deck.pop();
        p.hand.push(card);
        room.lastDiscard = null;

        if (room.mode === 3) {
            io.to(roomId).emit('gameLog', `${p.name} 无法出牌，摸了一张`);
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
        }

        io.to(roomId).emit('updateGame', sanitizeState(room));
    });

    // --- 出牌 ---
    socket.on('discardCard', ({ roomId, cardIndices }) => {
        const room = rooms[roomId];
        if (!room) return;
        const p = room.players[room.turnIndex];
        if (p.isBot || p.id !== socket.id) return;
        if (!cardIndices || cardIndices.length === 0) return;

        if (room.mode === 3) {
             if (cardIndices.length < 3) {
                 socket.emit('errorMsg', '无极限模式至少打出3张牌！');
                 return;
             }
        } else {
            if (cardIndices.length > 1) {
                socket.emit('errorMsg', '当前模式只能出一张牌');
                return;
            }
        }

        const orderedChars = [];
        cardIndices.forEach(idx => {
            if (idx >= 0 && idx < p.hand.length) orderedChars.push(p.hand[idx]);
        });

        const indicesToRemove = [...cardIndices].sort((a, b) => b - a);
        indicesToRemove.forEach(idx => {
            if (idx >= 0 && idx < p.hand.length) p.hand.splice(idx, 1);
        });

        orderedChars.forEach(char => {
            room.lastDiscard = { char: char, fromSeat: p.seat };
            room.discardPile.push(room.lastDiscard);
        });

        if (room.mode === 3) {
            if (p.hand.length === 0) {
                io.to(roomId).emit('playerWin', { name: p.name, sentence: "率先出完手牌！", mode: room.mode });
                resetGameData(room); 
                return;
            }
        }

        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        io.to(roomId).emit('updateGame', sanitizeState(room));

        if (room.mode === 1) checkAiTurn(roomId);
    });

    // --- 捡漏 (吃) [已修复：支持模式2] ---
    socket.on('eatCard', (roomId) => {
        const room = rooms[roomId];
        // 修正：允许模式 1 和 模式 2 都能吃牌
        if (!room || (room.mode !== 1 && room.mode !== 2)) return; 

        const p = room.players[room.turnIndex];
        if (p.isBot || p.id !== socket.id) return;

        if (!room.lastDiscard) return;

        room.discardPile.pop();
        p.hand.push(room.lastDiscard.char);
        room.lastDiscard = null;
        io.to(roomId).emit('updateGame', sanitizeState(room));
    });

    // --- 结束故事 ---
    socket.on('endStory', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.mode !== 2) return;
        const story = room.discardPile.map(c => c.char).join('');
        io.to(roomId).emit('playerWin', { name: "大家", sentence: story, mode: room.mode });
    });

    // --- 胡牌 ---
    socket.on('hu', ({roomId, sentence}) => {
        const room = rooms[roomId];
        if(room && room.mode === 1) {
            io.to(roomId).emit('playerWin', { name: room.players.find(p=>p.id===socket.id).name, sentence, mode: 1 });
        }
    });

    socket.on('swapHand', ({roomId, hand}) => {
        const room = rooms[roomId];
        if (room) {
            const p = room.players.find(p => p.id === socket.id);
            if (p && !p.isBot) p.hand = hand;
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1) {
                room.players.splice(pIndex, 1);
                const hasHuman = room.players.some(p => !p.isBot);
                if (!hasHuman) {
                    delete rooms[roomId];
                } else {
                    room.state = 'WAITING';
                    room.turnIndex = 0;
                    room.lastDiscard = null;
                    room.discardPile = [];
                    room.deck = [];
                    room.players = room.players.filter(p => !p.isBot);
                    room.players.forEach((p, i) => {
                        p.seat = i; p.isReady = false; p.hand = [];
                    });
                    io.to(roomId).emit('updatePlayers', room.players);
                    io.to(roomId).emit('errorMsg', '有人断线，房间已重置');
                    io.to(roomId).emit('gameStart', sanitizeState(room));
                }
                break;
            }
        }
    });
});

function startGame(roomId) {
    const room = rooms[roomId];
    room.state = 'PLAYING';
    room.deck = [...uniqueChars];
    for(let i=room.deck.length-1; i>0; i--) {
        const j = Math.floor(Math.random()*(i+1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }
    room.players.forEach(p => {
        p.hand = [];
        for(let i=0; i<13; i++) if(room.deck.length>0) p.hand.push(room.deck.pop());
    });

    room.turnIndex = 0; 
    room.lastDiscard = null;
    room.discardPile = [];

    io.to(roomId).emit('gameStart', sanitizeState(room));
    if (room.mode === 1) checkAiTurn(roomId);
}

function resetGameData(room) {
    room.state = 'WAITING';
    room.players.forEach(p => { p.isReady = false; p.hand = []; });
}

function endNoLimitGame(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    let winner = room.players[0];
    let minCards = 999;
    room.players.forEach(p => {
        if(p.hand.length < minCards) {
            minCards = p.hand.length;
            winner = p;
        }
    });
    io.to(roomId).emit('playerWin', { name: winner.name, sentence: `牌堆耗尽，${winner.name} 剩余手牌最少获胜！`, mode: 3 });
}

function checkAiTurn(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'PLAYING' || room.mode !== 1) return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.isBot) {
        const delay = 1000 + Math.random() * 1000;
        setTimeout(() => {
            if (!rooms[roomId]) return;
            botPlayStep(roomId);
        }, delay);
    }
}

function botPlayStep(roomId) {
    const room = rooms[roomId];
    const bot = room.players[room.turnIndex];

    if (room.deck.length === 0) { io.to(roomId).emit('gameLog', '流局'); return; }

    const card = room.deck.pop();
    bot.hand.push(card);
    room.lastDiscard = null; 
    io.to(roomId).emit('updateGame', sanitizeState(room));

    setTimeout(() => {
        if (!rooms[roomId]) return;
        const discardIdx = Math.floor(Math.random() * bot.hand.length);
        const discardCard = bot.hand.splice(discardIdx, 1)[0];
        room.lastDiscard = { char: discardCard, fromSeat: bot.seat };
        room.discardPile.push(room.lastDiscard);
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        io.to(roomId).emit('updateGame', sanitizeState(room));
        checkAiTurn(roomId);
    }, 800);
}

function sanitizeState(room) {
    return {
        mode: room.mode,
        discardPile: room.discardPile,
        turnIndex: room.turnIndex,
        lastDiscard: room.lastDiscard,
        players: room.players.map(p => ({
            seat: p.seat, 
            name: p.name, 
            cardCount: p.hand.length, 
            hand: p.hand,
            isBot: p.isBot
        }))
    };
}

// 适配云平台端口
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server running on port ${port}`));

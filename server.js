// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Glitch 환경 포트 호환 (기본 3000)
const PORT = process.env.PORT || 3000;
const TEACHER_PW = "qazxdr579*";

// 1. 정적 파일 서빙용 HTTP 서버
const server = http.createServer((req, res) => {
    let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath);
    let contentType = 'text/html';

    if (ext === '.js') contentType = 'text/javascript';
    else if (ext === '.css') contentType = 'text/css';
    else if (ext === '.json') contentType = 'application/json';
    else if (ext === '.png') contentType = 'image/png';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
            res.end(content, 'utf-8');
        }
    });
});

// 2. WebSocket 서버 생성
const wss = new WebSocket.Server({ server });

let players = new Map(); 
let rooms = new Map();   
let tournamentStarted = false;
let tournamentEnded = false;
let useTimer = false;
let timerSeconds = 180; 

function broadcastLobbyState() {
    const playerList = Array.from(players.values()).map(p => ({
        id: p.id,
        nickname: p.nickname,
        avatar: p.avatar,
        role: p.role,
        wins: p.wins,
        losses: p.losses,
        margin: p.wins - p.losses,
        state: p.state
    }));

    const activeRoomsCount = Array.from(rooms.values()).filter(r => !r.finished).length;

    const payload = JSON.stringify({
        type: 'LOBBY_UPDATE',
        players: playerList,
        tournamentStarted,
        tournamentEnded,
        useTimer,
        timerSeconds,
        activeRoomsCount
    });

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function createRoom(p1, p2, isAi = false, aiLevel = 4) {
    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    
    const p1Color = Math.random() < 0.5 ? 1 : 2;
    const p2Color = p1Color === 1 ? 2 : 1;

    p1.state = 'playing';
    p1.roomId = roomId;

    if (!isAi) {
        p2.state = 'playing';
        p2.roomId = roomId;
    }

    const roomData = {
        id: roomId,
        p1: { ws: p1.ws, id: p1.id, nickname: p1.nickname, avatar: p1.avatar, color: p1Color },
        p2: isAi ? { id: 'AI', nickname: `Lv.${aiLevel} AI봇`, avatar: '🤖', color: p2Color, isAi: true, level: aiLevel }
                 : { ws: p2.ws, id: p2.id, nickname: p2.nickname, avatar: p2.avatar, color: p2Color, isAi: false },
        turn: 1,
        useTimer,
        timeLeft: timerSeconds,
        finished: false
    };

    rooms.set(roomId, roomData);

    p1.ws.send(JSON.stringify({
        type: 'GAME_START',
        roomId,
        myColor: p1Color,
        opponent: { nickname: roomData.p2.nickname, avatar: roomData.p2.avatar, isAi, level: aiLevel },
        useTimer,
        timerSeconds: timerSeconds
    }));

    if (!isAi) {
        p2.ws.send(JSON.stringify({
            type: 'GAME_START',
            roomId,
            myColor: p2Color,
            opponent: { nickname: p1.nickname, avatar: p1.avatar, isAi: false },
            useTimer,
            timerSeconds: timerSeconds
        }));
    }

    if (useTimer) {
        roomData.interval = setInterval(() => {
            if (roomData.finished) {
                clearInterval(roomData.interval);
                return;
            }
            roomData.timeLeft--;

            const timerPayload = JSON.stringify({
                type: 'TIMER_TICK',
                timeLeft: roomData.timeLeft
            });
            if (p1.ws && p1.ws.readyState === WebSocket.OPEN) p1.ws.send(timerPayload);
            if (!isAi && p2.ws && p2.ws.readyState === WebSocket.OPEN) p2.ws.send(timerPayload);

            if (roomData.timeLeft <= 0) {
                clearInterval(roomData.interval);
                const loserColor = roomData.turn;
                const winnerColor = loserColor === 1 ? 2 : 1;
                endGame(roomId, winnerColor, "시간 초과로 승부가 결정되었습니다!");
            }
        }, 1000);
    }

    broadcastLobbyState();
}

function checkRollingMatch() {
    if (!tournamentStarted || tournamentEnded) return;

    const lobbyStudents = Array.from(players.values()).filter(p => p.role === 'student' && p.state === 'lobby');

    if (lobbyStudents.length < 6) return;

    lobbyStudents.sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses));

    while (lobbyStudents.length >= 2) {
        const p1 = lobbyStudents.shift();
        const p2 = lobbyStudents.shift();
        createRoom(p1, p2, false);
    }

    if (lobbyStudents.length === 1) {
        const lastStudent = lobbyStudents.shift();
        const randomAiLevel = Math.floor(Math.random() * 7) + 4;
        createRoom(lastStudent, null, true, randomAiLevel);
    }
}

function endGame(roomId, winnerColor, reason) {
    const room = rooms.get(roomId);
    if (!room || room.finished) return;
    room.finished = true;
    if (room.interval) clearInterval(room.interval);

    let p1Won = (room.p1.color === winnerColor);
    let p2Won = (!room.p2.isAi && room.p2.color === winnerColor);

    const p1Player = Array.from(players.values()).find(p => p.id === room.p1.id);
    if (p1Player) {
        p1Player.state = 'lobby';
        p1Player.roomId = null;
        if (winnerColor === 0) {}
        else if (p1Won) p1Player.wins++;
        else p1Player.losses++;
    }

    if (!room.p2.isAi) {
        const p2Player = Array.from(players.values()).find(p => p.id === room.p2.id);
        if (p2Player) {
            p2Player.state = 'lobby';
            p2Player.roomId = null;
            if (winnerColor === 0) {}
            else if (p2Won) p2Player.wins++;
            else p2Player.losses++;
        }
    }

    const resultPayload = (color, won) => JSON.stringify({
        type: 'GAME_OVER',
        winnerColor,
        isWin: won,
        isDraw: winnerColor === 0,
        reason
    });

    if (room.p1.ws && room.p1.ws.readyState === WebSocket.OPEN) {
        room.p1.ws.send(resultPayload(room.p1.color, p1Won));
    }
    if (!room.p2.isAi && room.p2.ws && room.p2.ws.readyState === WebSocket.OPEN) {
        room.p2.ws.send(resultPayload(room.p2.color, p2Won));
    }

    rooms.delete(roomId);
    broadcastLobbyState();

    setTimeout(checkRollingMatch, 1500);

    if (tournamentEnded) {
        checkTournamentFinishAll();
    }
}

function checkTournamentFinishAll() {
    const activeRooms = Array.from(rooms.values()).filter(r => !r.finished);
    if (activeRooms.length === 0) {
        const finalRanking = Array.from(players.values())
            .filter(p => p.role === 'student')
            .sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses) || b.wins - a.wins);

        const ceremonyPayload = JSON.stringify({
            type: 'TOURNAMENT_CEREMONY',
            ranking: finalRanking
        });

        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(ceremonyPayload);
            }
        }
    }
}

wss.on('connection', (ws) => {
    let currentUser = null;

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            if (data.type === 'JOIN') {
                const { nickname, avatar, role, password } = data;
                
                let validatedRole = 'student';
                if (role === 'teacher') {
                    if (password === TEACHER_PW) {
                        validatedRole = 'teacher';
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: '교사용 비밀번호가 올바르지 않습니다!' }));
                        return;
                    }
                }

                currentUser = {
                    id: 'usr_' + Math.random().toString(36).substr(2, 7),
                    ws,
                    nickname: nickname || (validatedRole === 'teacher' ? '관리 교사' : '오목 꿈나무'),
                    avatar: avatar || (validatedRole === 'teacher' ? '👨‍🏫' : '🐥'),
                    role: validatedRole,
                    wins: 0,
                    losses: 0,
                    state: 'lobby',
                    roomId: null
                };

                players.set(ws, currentUser);
                ws.send(JSON.stringify({ type: 'JOIN_SUCCESS', user: currentUser }));
                broadcastLobbyState();
            }

            if (data.type === 'SET_TIMER_CONFIG') {
                if (!currentUser || currentUser.role !== 'teacher') return;
                useTimer = !!data.useTimer;
                timerSeconds = parseInt(data.timerSeconds, 10) || 180;
                broadcastLobbyState();
            }

            if (data.type === 'START_TOURNAMENT') {
                if (!currentUser || currentUser.role !== 'teacher') return;
                tournamentStarted = true;
                tournamentEnded = false;

                const lobbyStudents = shuffle(Array.from(players.values()).filter(p => p.role === 'student' && p.state === 'lobby'));

                while (lobbyStudents.length >= 2) {
                    const p1 = lobbyStudents.shift();
                    const p2 = lobbyStudents.shift();
                    createRoom(p1, p2, false);
                }

                if (lobbyStudents.length === 1) {
                    const lastStudent = lobbyStudents.shift();
                    const randomAiLevel = Math.floor(Math.random() * 7) + 4;
                    createRoom(lastStudent, null, true, randomAiLevel);
                }

                broadcastLobbyState();
            }

            if (data.type === 'END_TOURNAMENT') {
                if (!currentUser || currentUser.role !== 'teacher') return;
                tournamentEnded = true;
                broadcastLobbyState();
                checkTournamentFinishAll();
            }

            if (data.type === 'MOVE') {
                if (!currentUser || !currentUser.roomId) return;
                const room = rooms.get(currentUser.roomId);
                if (!room || room.finished) return;

                const { r, c, color } = data;
                room.turn = color === 1 ? 2 : 1;

                if (room.p1.id === currentUser.id) {
                    if (!room.p2.isAi && room.p2.ws && room.p2.ws.readyState === WebSocket.OPEN) {
                        room.p2.ws.send(JSON.stringify({ type: 'OPPONENT_MOVE', r, c, color }));
                    }
                } else {
                    if (room.p1.ws && room.p1.ws.readyState === WebSocket.OPEN) {
                        room.p1.ws.send(JSON.stringify({ type: 'OPPONENT_MOVE', r, c, color }));
                    }
                }
            }

            if (data.type === 'REPORT_WIN') {
                if (!currentUser || !currentUser.roomId) return;
                endGame(currentUser.roomId, data.winnerColor, data.reason);
            }

        } catch (e) {
            console.error('Socket Message Error:', e);
        }
    });

    ws.on('close', () => {
        if (currentUser) {
            if (currentUser.roomId) {
                const room = rooms.get(currentUser.roomId);
                if (room && !room.finished) {
                    const winnerColor = (room.p1.id === currentUser.id) ? room.p2.color : room.p1.color;
                    endGame(currentUser.roomId, winnerColor, "상대방의 연결이 종료되어 기권패 처리되었습니다.");
                }
            }
            players.delete(ws);
            broadcastLobbyState();
        }
    });
});

server.listen(PORT, () => {
    console.log(`🎮 [오목 월드] 온라인 서버 가동 완료 (Port: ${PORT})`);
});
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Deepgram } = require('@deepgram/sdk');
const say = require('say');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Настройка статической раздачи (фронтенд в папке public)
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация памяти (попытка загрузить из файла)
let memory = {
  faces: [],               // { name, descriptor }
  conversationLog: [],     // история диалога {time, from, text}
  emotionHistory: [],      // история эмоций {time, emotion}
  state: { light: false }, // состояние умного дома (пример)
  lastEmotion: null,
  lastFaceDescriptor: null
};

const memoryPath = path.join(__dirname, 'memory.json');
if (fs.existsSync(memoryPath)) {
  try {
    const data = fs.readFileSync(memoryPath);
    memory = JSON.parse(data);
  } catch (err) {
    console.error('Error reading memory.json:', err);
  }
}

function saveMemory() {
  try {
    fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error('Error writing memory.json:', err);
  }
}

// Deepgram ASR клиент (если ключ указан)
const DG_KEY = process.env.DEEPGRAM_API_KEY;
let deepgram = null;
if (DG_KEY) {
  try {
    deepgram = new Deepgram(DG_KEY);
  } catch (err) {
    console.error('Deepgram initialization error:', err);
  }
}

// Socket.IO: аутентификация по токену
io.use((socket, next) => {
  const token = socket.handshake.query.token;
  const validToken = process.env.ADMIN_TOKEN || 'secret123';
  if (!token || token !== validToken) {
    return next(new Error('Authentication error'));
  }
  next();
});

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  socket.join('room1');

  // WebRTC signaling handlers
  socket.on('rtc-offer', (offer) => {
    socket.to('room1').emit('rtc-offer', offer);
  });
  socket.on('rtc-answer', (answer) => {
    socket.to('room1').emit('rtc-answer', answer);
  });
  socket.on('rtc-candidate', (candidate) => {
    socket.to('room1').emit('rtc-candidate', candidate);
  });

  // Live transcription via Deepgram
  let deepgramLive = null;
  if (deepgram) {
    try {
      deepgramLive = deepgram.transcription.live({ punctuate: true, utterances: true });
      deepgramLive.on('transcriptReceived', (dgData) => {
        const dgResult = JSON.parse(dgData);
        const transcript = dgResult.channel.alternatives[0].transcript;
        if (dgResult.is_final && transcript) {
          console.log('👂 Heard:', transcript);
          memory.conversationLog.push({ time: Date.now(), from: 'user', text: transcript });
          socket.emit('transcript', transcript);
          handleVoiceCommand(transcript, socket);
          saveMemory();
        }
      });
    } catch (err) {
      console.error('Deepgram live transcription error:', err);
    }
  }

  // Receive audio stream from client microphone
  socket.on('microphone-stream', (data) => {
    if (deepgramLive) {
      deepgramLive.send(data);
    }
  });

  // Receive face and emotion data from client
  socket.on('face-data', (data) => {
    const { descriptor, emotion } = data;
    if (emotion) {
      if (emotion !== memory.lastEmotion) {
        memory.lastEmotion = emotion;
        memory.emotionHistory.push({ time: Date.now(), emotion });
      }
    }
    if (descriptor) {
      memory.lastFaceDescriptor = descriptor;
    }
    
    // Face recognition
    let recognizedName = null;
    if (descriptor && memory.faces.length > 0) {
      const desc = Float32Array.from(descriptor);
      let bestDistance = Infinity;
      for (const person of memory.faces) {
        const knownDesc = Float32Array.from(person.descriptor);
        let sumSq = 0;
        for (let i = 0; i < knownDesc.length; i++) {
          const diff = knownDesc[i] - desc[i];
          sumSq += diff * diff;
        }
        const distance = Math.sqrt(sumSq);
        if (distance < 0.6 && distance < bestDistance) {
          bestDistance = distance;
          recognizedName = person.name;
        }
      }
    }
    
    // AI reaction to smile
    if (emotion === 'happy') {
      const greeting = recognizedName 
        ? `Привет, ${recognizedName}! Рад видеть твою улыбку.` 
        : 'Привет! Рад видеть твою улыбку.';
      speakText(greeting, socket);
    }
  });

  // Smart home commands from UI
  socket.on('smart-home', ({ device, action }) => {
    if (device === 'light') {
      memory.state.light = (action === 'on');
      console.log('💡 Light state changed via UI:', memory.state.light);
      io.emit('light-state', memory.state.light);
      saveMemory();
    }
  });

  // LiDAR data stream
  socket.on('lidar-data', (frame) => {
    memory.lastLidarFrame = frame;
    socket.broadcast.emit('lidar-update', frame);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
    if (deepgramLive) {
      deepgramLive.finish();
    }
  });
});

// Voice command handler
function handleVoiceCommand(transcript, socket) {
  const text = transcript.toLowerCase();
  if (text.includes('включи свет')) {
    memory.state.light = true;
    speakText('Хорошо, включаю свет.', socket);
    console.log('💡 Command: Light ON');
    io.emit('light-state', memory.state.light);
    memory.conversationLog.push({ time: Date.now(), from: 'assistant', text: 'Свет включен.' });
  } else if (text.includes('выключи свет')) {
    memory.state.light = false;
    speakText('Выключаю свет.', socket);
    console.log('💡 Command: Light OFF');
    io.emit('light-state', memory.state.light);
    memory.conversationLog.push({ time: Date.now(), from: 'assistant', text: 'Свет выключен.' });
  } else if (text.includes('запомни лицо')) {
    let name = null;
    const match = text.match(/запомни лицо (как )?(.+)$/);
    if (match) {
      name = match[2].trim();
    }
    if (!name) {
      speakText('Как назвать этого человека?', socket);
    } else if (memory.lastFaceDescriptor) {
      memory.faces.push({ name, descriptor: memory.lastFaceDescriptor });
      speakText(`Запомнил лицо как ${name}.`, socket);
      console.log(`👤 Face saved: ${name}`);
      memory.conversationLog.push({ time: Date.now(), from: 'system', text: `Face "${name}" remembered` });
      saveMemory();
    } else {
      speakText('Не вижу лицо для запоминания.', socket);
    }
  } else {
    console.log('🤖 Forwarding to AI (not implemented):', transcript);
    speakText('Извините, я не понял команду.', socket);
    memory.conversationLog.push({ time: Date.now(), from: 'assistant', text: 'Не понял команду.' });
  }
  saveMemory();
}

// Text-to-Speech
function speakText(text, socket) {
  console.log('💬 Assistant says:', text);
  try {
    // say.speak(text, 'Microsoft Irina Desktop', 1.0);
  } catch (err) {
    console.error('TTS error:', err);
  }
  socket.emit('tts', text);
  memory.conversationLog.push({ time: Date.now(), from: 'assistant', text });
}

// Admin panel
app.get('/admin', (req, res) => {
  const token = req.query.token;
  const validToken = process.env.ADMIN_TOKEN || 'secret123';
  if (token !== validToken) {
    return res.status(401).send('Unauthorized');
  }
  let html = `<h1>Admin Panel</h1>`;
  html += '<h2>Known Faces:</h2><ul>';
  memory.faces.forEach(person => {
    html += `<li>${person.name}</li>`;
  });
  html += '</ul>';
  html += '<h2>Smart Home State:</h2>';
  html += `<p>Light: ${memory.state.light ? 'ON' : 'OFF'}</p>`;
  html += '<h2>Emotion History:</h2><pre>';
  memory.emotionHistory.forEach(e => {
    const timeStr = new Date(e.time).toLocaleTimeString();
    html += `[${timeStr}] ${e.emotion}\n`;
  });
  html += '</pre>';
  html += '<h2>Conversation Log:</h2><pre>';
  memory.conversationLog.forEach(entry => {
    const timeStr = new Date(entry.time).toLocaleTimeString();
    html += `[${timeStr}] ${entry.from}: ${entry.text}\n`;
  });
  html += '</pre>';
  res.send(html);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin?token=${process.env.ADMIN_TOKEN || 'secret123'}`);
});
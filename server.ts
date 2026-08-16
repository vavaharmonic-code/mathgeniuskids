import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import agoraTokenPkg from 'agora-token';

const agoraToken = (agoraTokenPkg as any)?.default || agoraTokenPkg;
const { RtcTokenBuilder, RtcRole } = agoraToken;

const app = express();
const server = http.createServer(app);
const PORT = 3000;

// Setup WebSocket Server for Live Classroom real-time chat and reaction broadcasts
const wss = new WebSocketServer({ noServer: true });

interface ClassroomClient extends WebSocket {
  roomName?: string;
  senderName?: string;
  role?: string;
  isAlive?: boolean;
}

const roomClients = new Map<string, Set<ClassroomClient>>();

wss.on('connection', (ws: ClassroomClient) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const { type, room, senderName, role, text, emoji, questionText } = data;

      if (!room) return;
      const normalizedRoom = String(room).trim().toLowerCase();

      if (type === 'join') {
        // Leave previous room if any
        if (ws.roomName && roomClients.has(ws.roomName)) {
          roomClients.get(ws.roomName)?.delete(ws);
        }

        ws.roomName = normalizedRoom;
        ws.senderName = senderName || 'Guest';
        ws.role = role || 'student';

        if (!roomClients.has(normalizedRoom)) {
          roomClients.set(normalizedRoom, new Set());
        }
        roomClients.get(normalizedRoom)!.add(ws);

        // Notify room members of join
        const count = roomClients.get(normalizedRoom)!.size;
        const joinMsg = JSON.stringify({
          type: 'system',
          text: `${ws.senderName} (${ws.role}) joined the classroom`,
          room: normalizedRoom,
          participantCount: count,
          timestamp: Date.now()
        });

        roomClients.get(normalizedRoom)!.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(joinMsg);
          }
        });
      } else if (type === 'chat') {
        if (!roomClients.has(normalizedRoom)) return;
        const chatMsg = JSON.stringify({
          type: 'chat',
          senderName: senderName || ws.senderName || 'Anonymous',
          role: role || ws.role || 'student',
          text: String(text || '').trim(),
          room: normalizedRoom,
          timestamp: Date.now()
        });

        roomClients.get(normalizedRoom)!.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(chatMsg);
          }
        });
      } else if (type === 'reaction') {
        if (!roomClients.has(normalizedRoom)) return;
        const reactionMsg = JSON.stringify({
          type: 'reaction',
          senderName: senderName || ws.senderName || 'Anonymous',
          emoji: emoji || '👏',
          room: normalizedRoom,
          timestamp: Date.now()
        });

        roomClients.get(normalizedRoom)!.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(reactionMsg);
          }
        });
      } else if (type === 'math-sync') {
        if (!roomClients.has(normalizedRoom)) return;
        const syncMsg = JSON.stringify({
          type: 'math-sync',
          senderName: senderName || ws.senderName || 'Anonymous',
          questionText: String(questionText || ''),
          room: normalizedRoom,
          timestamp: Date.now()
        });

        roomClients.get(normalizedRoom)!.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(syncMsg);
          }
        });
      }
    } catch (e) {
      console.warn('[WS] Error processing message:', e);
    }
  });

  ws.on('close', () => {
    if (ws.roomName && roomClients.has(ws.roomName)) {
      const set = roomClients.get(ws.roomName);
      set?.delete(ws);
      if (set && set.size > 0) {
        const leaveMsg = JSON.stringify({
          type: 'system',
          text: `${ws.senderName || 'Participant'} left the classroom`,
          room: ws.roomName,
          participantCount: set.size,
          timestamp: Date.now()
        });
        set.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(leaveMsg);
          }
        });
      } else if (set && set.size === 0) {
        roomClients.delete(ws.roomName);
      }
    }
  });
});

// Periodic heartbeat to keep connections alive
const pingInterval = setInterval(() => {
  wss.clients.forEach((client) => {
    const ws = client as ClassroomClient;
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

// Handle HTTP upgrade for WebSocket
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
  if (pathname === '/ws/classroom' || pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Agora Video Call Configuration Endpoint
app.get('/api/agora/config', (req, res) => {
  const appId = (process.env.AGORA_APP_ID || '').trim();
  const appCertificate = (process.env.AGORA_APP_CERTIFICATE || process.env.AGORA_APP_SECRET || '').trim();
  res.json({
    appId,
    hasCertificate: Boolean(appCertificate && appCertificate.length > 0),
    configured: Boolean(appId && appId.length > 0)
  });
});

// Agora Dynamic RTC Token Generator Endpoint
app.get('/api/agora/token', (req, res) => {
  try {
    const rawAppId = req.query.appId ? String(req.query.appId).trim() : '';
    const rawCert = req.query.certificate ? String(req.query.certificate).trim() : '';
    
    const appId = rawAppId || (process.env.AGORA_APP_ID || '').trim();
    const appCertificate = rawCert || (process.env.AGORA_APP_CERTIFICATE || process.env.AGORA_APP_SECRET || '').trim();
    const channelName = String(req.query.channel || 'Room A').trim();
    const uidStr = req.query.uid ? String(req.query.uid).trim() : '0';
    const roleParam = String(req.query.role || 'publisher').toLowerCase();

    if (!appId) {
      return res.status(400).json({ error: 'Agora App ID is not configured' });
    }

    if (!appCertificate) {
      // If no certificate configured, static key or no-token mode is assumed
      return res.json({
        token: null,
        appId,
        channel: channelName,
        hasCertificate: false,
        message: 'No App Certificate configured in backend. Use static key or set AGORA_APP_CERTIFICATE.'
      });
    }

    const role = roleParam === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
    const expireTimeInSeconds = 3600 * 24; // 24 hours token expiration
    const privilegeExpireTime = 3600 * 24;

    let token = '';
    const numericUid = parseInt(uidStr, 10);

    if (!isNaN(numericUid) && numericUid > 0) {
      token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        appCertificate,
        channelName,
        numericUid,
        role,
        expireTimeInSeconds,
        privilegeExpireTime
      );
    } else {
      token = RtcTokenBuilder.buildTokenWithUserAccount(
        appId,
        appCertificate,
        channelName,
        uidStr || '0',
        role,
        expireTimeInSeconds,
        privilegeExpireTime
      );
    }

    return res.json({
      token,
      appId,
      channel: channelName,
      hasCertificate: true
    });
  } catch (err: any) {
    console.error('[Agora Token Generation Error]:', err);
    return res.status(500).json({ error: err?.message || 'Failed to generate Agora token' });
  }
});

// Helper function for lazy Gemini API client initialization
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const languageNames: Record<string, string> = {
  en: 'English',
  ta: 'Tamil (தமிழ்)',
  hi: 'Hindi (हिन्दी)',
  ml: 'Malayalam (മലയാളം)',
  te: 'Telugu (తెలుగు)',
  kn: 'Kannada (ಕನ್ನಡ)',
  zh: 'Chinese (Simplified 中文)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  ar: 'Arabic (العربية)',
  ru: 'Russian (Русский)',
  nl: 'Dutch (Nederlands)',
  pt: 'Portuguese (Português)',
  ms: 'Malay (Bahasa Melayu)',
  ja: 'Japanese (日本語)'
};

// AI Chatbot Helper API Route for Students, Teachers, and Parents with full regional language support
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, userRole, userLanguage, userStandard } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    const langCode = (userLanguage && languageNames[userLanguage]) ? userLanguage : 'en';
    const targetLangName = languageNames[langCode] || 'English';
    const role = userRole || 'student';
    const standard = userStandard || 'General Grade';

    const lastUserMessage = [...messages].reverse().find((m: { role: string; content: string }) => m.role === 'user')?.content || '';

    const ai = getGeminiClient();
    if (!ai) {
      const fallbackReply = generateSmartFallbackReply(lastUserMessage, role, langCode, standard);
      return res.json({ reply: fallbackReply });
    }

    const systemInstruction = `You are EduBot, the empathetic, intelligent, and cheerful multilingual AI Assistant built into EduMatrix Master (Math Master).
EduMatrix Master is an interactive elementary and middle school mathematics app designed for Students (Grades 1st to 8th Standard), Teachers, and Parents.

KEY FEATURES & CAPABILITIES OF EDUMATRIX MASTER:
1. Practice Quizzes: Generates dynamic math quizzes covering Addition, Subtraction, Multiplication, Division, Word Problems, Fractions, Decimals, Algebra, Geometry, and Math Tricks.
2. Custom Quiz Generator: Allows teachers and parents to customize number of questions (10 to 100), timer duration, difficulty (Easy, Medium, Hard, Challenge), and operational types.
3. Printable Worksheets & Answer Keys: Generates clean, printer-friendly PDF worksheets for classroom assignments or offline home practice with detachable answer keys.
4. WhatsApp Sharing: Teachers can instantly share active quiz links or worksheet codes directly with students or parents via WhatsApp.
5. Voice Tutor & Speech: Includes interactive audio explanations and voice assistance for primary students.
6. Multi-language Support: Supports 15 languages (English, Tamil, Hindi, Malayalam, Telugu, Kannada, Chinese, Spanish, French, Arabic, Russian, Dutch, Portuguese, Malay, Japanese).
7. Role Perspectives:
   - Student Mode: Gamified learning, high score badges, audio guidance, handwriting canvas, and progress stars.
   - Teacher Mode: School branding, class roster performance, worksheet printing, and automated grading.
   - Parent Mode: Tracking child's standard, home revision, parent-teacher signatures, and report cards.

USER CONTEXT:
- Active UI Language: ${targetLangName} (Code: "${langCode}")
- Current Role: ${role}
- Grade/Standard: ${standard}

CRITICAL MULTILINGUAL DIRECTIVE:
1. The user has selected **${targetLangName}** as their language in the application.
2. You MUST write your ENTIRE response in **${targetLangName}**!
3. If the user asks a question in ${targetLangName}, answer directly in ${targetLangName}.
4. If the user asks in English or transliterated words (e.g., Tamil/Tanglish: "worksheet epdi download panrathu", Hindi/Hinglish: "worksheet kaise print kare", etc.), fully understand their question and translate/deliver the entire helpful answer in **${targetLangName}** so they can easily read and understand it in their chosen language.
5. If the user explicitly asks to reply in another language (e.g. "explain in English"), honor that specific request.
6. If asked a math question (e.g., "what is 25 x 4", fractions, word problems), solve it step-by-step with clear explanations in **${targetLangName}**.
7. If asked about app features (printing worksheets, sharing on WhatsApp, changing grade, checking score), provide clear, numbered step-by-step instructions in **${targetLangName}**.
8. Keep answers clear, encouraging, well-formatted with markdown and friendly emojis.`;

    // Map conversation messages to contents format for GoogleGenAI SDK
    const contents = messages.map((m: { role: string; content: string }) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));

    // Robust model cascade prioritized by availability and speed
    const modelsToTry = ['gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.7-flash'];
    let reply = '';

    for (const modelName of modelsToTry) {
      // Allow up to 2 attempts for transient 503 spikes with brief backoff
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents,
            config: {
              systemInstruction,
              temperature: 0.7,
            }
          });
          if (response && response.text) {
            reply = response.text;
            break;
          }
        } catch (err: any) {
          const status = err?.status || err?.code || (err?.error && err.error.code);
          if (status === 503 && attempt === 0) {
            // Brief pause on 503 high demand spike before immediate retry or next model
            await new Promise(r => setTimeout(r, 400));
            continue;
          }
          console.warn(`[AI Chat] Notice: Model ${modelName} unavailable (${status || 'error'}), proceeding to fallback...`);
          break; // move to next model
        }
      }
      if (reply) break;
    }

    if (!reply) {
      reply = generateSmartFallbackReply(lastUserMessage, role, langCode, standard);
    }

    return res.json({ reply });
  } catch (err: unknown) {
    console.error('Error in /api/chat:', err);
    const lastUserMsg = req.body?.messages ? [...req.body.messages].reverse().find((m: { role: string; content: string }) => m.role === 'user')?.content || '' : '';
    const fallback = generateSmartFallbackReply(lastUserMsg, req.body?.userRole, req.body?.userLanguage, req.body?.userStandard);
    return res.json({ reply: fallback });
  }
});

// Comprehensive Multilingual Fallback Engine across all 15 regional languages
function generateSmartFallbackReply(userText: string, userRole?: string, userLang?: string, userStandard?: string): string {
  const query = (userText || '').toLowerCase().trim();
  const lang = (userLang && languageNames[userLang]) ? userLang : 'en';
  const role = userRole || 'student';

  // Math calculation evaluator for expressions like "5 x 5", "100 / 4", "15 + 28", "50 - 15", "sqrt(16)"
  const mathMatch = query.match(/(\d+(?:\.\d+)?)\s*([\+\-\*\/x×÷\^])\s*(\d+(?:\.\d+)?)/);
  if (mathMatch) {
    const num1 = parseFloat(mathMatch[1]);
    const op = mathMatch[2];
    const num2 = parseFloat(mathMatch[3]);
    let result = 0;
    let opSymbol = op;
    if (op === '+') result = num1 + num2;
    else if (op === '-') result = num1 - num2;
    else if (op === '*' || op === 'x' || op === '×') { result = num1 * num2; opSymbol = '×'; }
    else if (op === '/' || op === '÷') { result = num2 !== 0 ? num1 / num2 : NaN; opSymbol = '÷'; }
    else if (op === '^') { result = Math.pow(num1, num2); opSymbol = '^'; }

    if (!isNaN(result)) {
      return getLocalizedMathAnswer(num1, opSymbol, num2, result, lang);
    }
  }

  // Detect Intent across multi-lingual keywords & phonetic terms
  const isGreeting = query.includes('hi') || query.includes('hello') || query.includes('hey') || 
    query.includes('வணக்கம்') || query.includes('வணகம்') || query.includes('नमस्ते') || query.includes('നമസ്കാരം') || 
    query.includes('నమస్కారం') || query.includes('ನಮಸ್ಕಾರ') || query.includes('hola') || query.includes('bonjour') || 
    query.includes('مرحبا') || query.includes('你好') || query.includes('привет') || query.includes('hallo') || 
    query.includes('olá') || query.includes('helo') || query.includes('こんにちは') || query.includes('vanakkam');

  const isWorksheet = query.includes('worksheet') || query.includes('print') || query.includes('pdf') || 
    query.includes('paper') || query.includes('download') || query.includes('தாள்') || query.includes('அச்சிட') || 
    query.includes('பதிவிறக்க') || query.includes('വർക്ക്‌ഷീറ്റ്') || query.includes('പ്രിന്റ്') || query.includes('వర్క్‌షీట్') || 
    query.includes('ವರ್ಕ್‌ಶೀಟ್') || query.includes('वर्कशीट') || query.includes('प्रिंट') || query.includes('feuille') || 
    query.includes('imprimer') || query.includes('hoja') || query.includes('imprimir') || query.includes('طباعة') || 
    query.includes('ورقة') || query.includes('打印') || query.includes('рабочий лист') || query.includes('печать') || 
    query.includes('werkblad') || query.includes('afdrukken') || query.includes('lembaran kerja') || query.includes('cetak') || 
    query.includes('ワークシート') || query.includes('印刷') || query.includes('epdi print') || query.includes('kaise print');

  const isWhatsApp = query.includes('whatsapp') || query.includes('share') || query.includes('send') || 
    query.includes('code') || query.includes('பகிர்') || query.includes('வாட்ஸ்அப்') || query.includes('ஷேர்') || 
    query.includes('പങ്കിടൽ') || query.includes('వాట్సాప్') || query.includes('ಹಂಚಿಕೆ') || query.includes('साझा') || 
    query.includes('शेयर') || query.includes('partager') || query.includes('compartir') || query.includes('مشاركة') || 
    query.includes('分享') || query.includes('поделиться') || query.includes('delen') || query.includes('compartilhar') || 
    query.includes('berkongsi') || query.includes('共有') || query.includes('epdi share') || query.includes('kaise share');

  const isScore = query.includes('score') || query.includes('progress') || query.includes('badge') || 
    query.includes('report') || query.includes('star') || query.includes('certificate') || query.includes('மதிப்பெண்') || 
    query.includes('முன்னேற்றம்') || query.includes('சான்றிதழ்') || query.includes('സ്കോർ') || query.includes('రిపోర్ట్') || 
    query.includes('ಸ್ಕೋರ್') || query.includes('प्रगति') || query.includes('स्कोर') || query.includes('résultat') || 
    query.includes('puntuación') || query.includes('درجات') || query.includes('成绩') || query.includes('результат') || 
    query.includes('scorekaart') || query.includes('relatório') || query.includes('laporan') || query.includes('成績') || 
    query.includes('epdi paakaradhu') || query.includes('kaise dekhe');

  const isTricks = query.includes('trick') || query.includes('tips') || query.includes('multiplication') || 
    query.includes('table') || query.includes('குறுக்கு வழி') || query.includes('பெருக்கல்') || query.includes('வாய்ப்பாடு') || 
    query.includes('ഗുണനം') || query.includes('ట్రిక్స్') || query.includes('ತಂತ್ರ') || query.includes('ट्रिक') || 
    query.includes('पहाड़ा') || query.includes('astuce') || query.includes('truco') || query.includes('حيل') || 
    query.includes('技巧') || query.includes('хитрости') || query.includes('trucjes') || query.includes('truques') || 
    query.includes('petua') || query.includes('裏ワザ') || query.includes('solli thanga') || query.includes('batao');

  const isSettings = query.includes('language') || query.includes('grade') || query.includes('standard') || 
    query.includes('change') || query.includes('மொழி') || query.includes('வகுப்பு') || query.includes('விருப்பம்') || 
    query.includes('ഭാഷ') || query.includes('తరగతి') || query.includes('ಭಾಷೆ') || query.includes('भाषा') || 
    query.includes('कक्षा') || query.includes('langue') || query.includes('idioma') || query.includes('لغة') || 
    query.includes('语言') || query.includes('язык') || query.includes('taal') || query.includes('bahasa') || query.includes('言語');

  if (isGreeting) {
    return getLocalizedGreeting(role, lang);
  }
  if (isWorksheet) {
    return getLocalizedWorksheetGuide(lang);
  }
  if (isWhatsApp) {
    return getLocalizedWhatsAppGuide(lang);
  }
  if (isScore) {
    return getLocalizedScoreGuide(lang);
  }
  if (isTricks) {
    return getLocalizedMathTricks(lang);
  }
  if (isSettings) {
    return getLocalizedSettingsGuide(lang);
  }

  // Default localized general help response
  return getLocalizedGeneralHelp(lang);
}

function getLocalizedMathAnswer(n1: number, op: string, n2: number, res: number, lang: string): string {
  const dict: Record<string, string> = {
    ta: `🔢 **கணிதத் தீர்வு:**\n\n${n1} ${op} ${n2} = **${res}**\n\nசிறப்பான பயிற்சி! மேலே உள்ள கணித செயல்பாடுகளை (கூட்டல், கழித்தல், பெருக்கல், வகுத்தல்) தேர்வு செய்து உங்கள் வேகத்தை சோதிக்கலாம்! 🌟`,
    hi: `🔢 **गणित हल:**\n\n${n1} ${op} ${n2} = **${res}**\n\nशानदार अभ्यास! आप ऊपर दिए गए जोड़, घटाव, गुणा और भाग के बटनों का चयन करके पूरे क्विज का अभ्यास कर सकते हैं! 🌟`,
    ml: `🔢 **ഗണിത പരിഹാരം:**\n\n${n1} ${op} ${n2} = **${res}**\n\nമികച്ച പരിശീലനം! മുകളിലെ ബാറിൽ നിന്ന് സങ്കലനം, വ്യവകലനം, ഗുണനം, ഹരണം എന്നിവ തിരഞ്ഞെടുത്ത് കൂടുതൽ പരിശീലിക്കാം! 🌟`,
    te: `🔢 **గణిత పరిష్కారం:**\n\n${n1} ${op} ${n2} = **${res}**\n\nచక్కని సాధన! పైన ఉన్న బార్ నుండి సంకలనం, వ్యవకలనం, గుణకారం, భాగహారం ఎంచుకుని మరిన్ని ప్రశ్నలను సాధన చేయండి! 🌟`,
    kn: `🔢 **ಗಣಿತ ಪರಿಹಾರ:**\n\n${n1} ${op} ${n2} = **${res}**\n\nಅತ್ಯುತ್ತಮ ಅಭ್ಯಾಸ! ಸಂಕಲನ, ವ್ಯವಕಲನ, ಗುಣಾಕಾರ, ಭಾಗಾಕಾರ ಆಯ್ಕೆಮಾಡಿ ಹೆಚ್ಚಿನ ಅಭ್ಯಾಸ ಮಾಡಿ! 🌟`,
    zh: `🔢 **数学解答：**\n\n${n1} ${op} ${n2} = **${res}**\n\n太棒了！您可以通过上方导航栏选择加、减、乘、除进行全面的数学测验练习！🌟`,
    es: `🔢 **Solución Matemática:**\n\n${n1} ${op} ${n2} = **${res}**\n\n¡Excelente práctica! Puedes elegir suma, resta, multiplicación o división en la barra superior para poner a prueba tu velocidad. 🌟`,
    fr: `🔢 **Solution Mathématique :**\n\n${n1} ${op} ${n2} = **${res}**\n\nBravo ! Vous pouvez choisir l'addition, la soustraction, la multiplication ou la division en haut pour tester votre rapidité. 🌟`,
    ar: `🔢 **الحل الرياضي:**\n\n${n1} ${op} ${n2} = **${res}**\n\nأحسنت! يمكنك اختيار الجمع، الطرح، الضرب، أو القسمة من الشريط العلوي لاختبار سرعتك في التدريب الكامل! 🌟`,
    ru: `🔢 **Математическое решение:**\n\n${n1} ${op} ${n2} = **${res}**\n\nОтличная работа! Вы можете выбрать сложение, вычитание, умножение или деление на панели сверху для тренировки! 🌟`,
    nl: `🔢 **Wiskundige oplossing:**\n\n${n1} ${op} ${n2} = **${res}**\n\nGoed gedaan! Kies optellen, aftrekken, vermenigvuldigen of delen in de bovenbalk om verder te oefenen! 🌟`,
    pt: `🔢 **Solução Matemática:**\n\n${n1} ${op} ${n2} = **${res}**\n\nÓtimo trabalho! Você pode selecionar adição, subtração, multiplicação ou divisão na barra superior para praticar! 🌟`,
    ms: `🔢 **Penyelesaian Matematik:**\n\n${n1} ${op} ${n2} = **${res}**\n\nBagus sekali! Anda boleh memilih penambahan, penolakan, pendaraban atau pembahagian di bar atas untuk berlatih! 🌟`,
    ja: `🔢 **計算の答え:**\n\n${n1} ${op} ${n2} = **${res}**\n\n素晴らしい練習です！上のバーから足し算、引き算、掛け算、割り算を選んでスピードクイズに挑戦してみましょう！🌟`
  };
  return dict[lang] || `🔢 **Math Solution:**\n\n${n1} ${op} ${n2} = **${res}**\n\nGreat practice! You can solve full dynamic quizzes in EduMatrix Master by choosing Addition, Subtraction, Multiplication, or Division on the top bar! 🌟`;
}

function getLocalizedGreeting(role: string, lang: string): string {
  const dict: Record<string, string> = {
    ta: `👋 **வணக்கம்! நான் EduBot**, EduMatrix Master-ன் AI வழிகாட்டி.\n\nநான் உங்களுக்கு உதவக்கூடியவை:\n- 📝 **பயிற்சி தாள் அச்சிடுதல்:** விடைக்குறிப்புகளுடன் கூடிய PDF தாள்களை உருவாக்குதல்.\n- 📲 **வாட்ஸ்அப் பகிர்வு:** வினாடி வினாக்களை மாணவர்களுக்கு நேரடியாக அனுப்புதல்.\n- 📊 **மதிப்பெண் கண்காணிப்பு:** மாணவர் முன்னேற்றம் மற்றும் சான்றிதழ் தயாரிப்பு.\n- 🧮 **கணித கேள்விகள்:** எந்த கணித கணக்கிற்கும் எளிய படிநிலைகளுடன் தீர்வு.\n\nஉங்களுக்கு என்ன உதவி வேண்டும்? கேளுங்கள்! 💡`,
    hi: `👋 **नमस्ते! मैं EduBot हूँ**, EduMatrix Master का AI सहायक।\n\nमैं आपकी इन कार्यों में मदद कर सकता हूँ:\n- 📝 **वर्कशीट प्रिंटिंग:** उत्तर कुंजी के साथ प्रिंट करने योग्य PDF वर्कशीट तैयार करना।\n- 📲 **व्हाट्सएप शेयर:** विद्यार्थियों को सीधे क्विज असाइनमेंट भेजना।\n- 📊 **प्रगति रिपोर्ट:** स्कोर ट्रैकिंग और प्रमाण पत्र बनाना।\n- 🧮 **गणित समाधान:** किसी भी गणित के सवाल का आसान हल पाना।\n\nआज आप क्या सीखना या करना चाहते हैं? 💡`,
    ml: `👋 **നമസ്കാരം! ഞാൻ EduBot ആണ്**, EduMatrix Master-ന്റെ AI സഹായി.\n\nഎനിക്ക് നിങ്ങളെ സഹായിക്കാൻ കഴിയുന്ന കാര്യങ്ങൾ:\n- 📝 **വർക്ക്‌ഷീറ്റ് പ്രിന്റിംഗ്:** ഉത്തരസൂചികയുള്ള PDF വർക്ക്‌ഷീറ്റുകൾ തയ്യാറാക്കൽ.\n- 📲 **വാട്ട്‌സ്ആപ്പ് ഷെയറിംഗ്:** വിദ്യാർത്ഥികൾക്ക് നേരിട്ട് ക്വിസ് അയക്കൽ.\n- 📊 **സ്കോർ ട്രാക്കിംഗ്:** റിപ്പോർട്ട് കാർഡുകളും സർട്ടിഫിക്കറ്റുകളും പരിശോധിക്കൽ.\n- 🧮 **കണക്ക് ചോദ്യങ്ങൾ:** എളുപ്പത്തിൽ കണക്ക് പരിഹരിക്കൽ.\n\nഎന്താണ് ഇന്ന് അറിയേണ്ടത്? ചോദിക്കൂ! 💡`,
    te: `👋 **నమస్కారం! నేను EduBot ని**, EduMatrix Master యొక్క AI సహాయకుడిని.\n\nనేను మీకు సహాయం చేయగల విషయాలు:\n- 📝 **వర్క్‌షీట్ ప్రింటింగ్:** సమాధానాలతో కూడిన PDF వర్క్‌షీట్‌లను తయారు చేయడం.\n- 📲 **వాట్సాప్ షేరింగ్:** విద్యార్థులకు నేరుగా క్విజ్ పంపడం.\n- 📊 **స్కోర్ రిపోర్ట్:** విద్యార్థి పురోగతి మరియు సర్టిఫికెట్లు.\n- 🧮 **గణిత పరిష్కారాలు:** ఏ గణిత లెక్కకైనా సులభమైన వివరణ.\n\nమీకు ఎలాంటి సహాయం కావాలి? అడగండి! 💡`,
    kn: `👋 **ನಮಸ್ಕಾರ! ನಾನು EduBot**, EduMatrix Master ನ AI ಸಹಾಯಕ.\n\nನಾನು ನಿಮಗೆ ಸಹಾಯ ಮಾಡಬಹುದಾದ ವಿಷಯಗಳು:\n- 📝 **ವರ್ಕ್‌ಶೀಟ್ ಪ್ರಿಂಟಿಂಗ್:** ಉತ್ತರ ಸಹಿತ PDF ವರ್ಕ್‌ಶೀಟ್ ರಚನೆ.\n- 📲 **ವಾಟ್ಸಾಪ್ ಹಂಚಿಕೆ:** ವಿದ್ಯಾರ್ಥಿಗಳಿಗೆ ಕ್ವಿಜ್ ಕಳುಹಿಸುವುದು.\n- 📊 **ಪ್ರಗತಿ ವರದಿ:** ಅಂಕಗಳ ಪರಿಶೀಲನೆ ಮತ್ತು ಪ್ರಮಾಣಪತ್ರಗಳು.\n- 🧮 **ಗಣಿತ ಪರಿಹಾರ:** ಯಾವುದೇ ಗಣಿತ ಪ್ರಶ್ನೆಗೆ ಸರಳ ಪರಿಹಾರ.\n\nನೀವು ಇಂದು ಏನು ತಿಳಿಯಲು ಬಯಸುತ್ತೀರಿ? ಕೇಳಿ! 💡`,
    zh: `👋 **您好！我是 EduBot**，EduMatrix Master 的智能数学助手。\n\n我可以协助您：\n- 📝 **打印练习题：** 快速生成带答案解析的 PDF 数学工作表。\n- 📲 **WhatsApp/社交分享：** 一键向学生或家长发送测验代码。\n- 📊 **成绩追踪：** 查看学生掌握情况与成绩单认证。\n- 🧮 **解答算术：** 提供分步骤的数学题解答与速算技巧。\n\n请告诉我您需要什么帮助？💡`,
    es: `👋 **¡Hola! Soy EduBot**, tu asistente de IA para EduMatrix Master.\n\nPuedo ayudarte con:\n- 📝 **Imprimir Hojas de Trabajo:** Generar PDFs con hojas de respuestas.\n- 📲 **Compartir en WhatsApp:** Enviar cuestionarios y códigos a los alumnos.\n- 📊 **Seguimiento de Notas:** Revisar progreso, diplomas y firmas.\n- 🧮 **Resolver Problemas:** Explicaciones paso a paso de matemáticas.\n\n¿En qué te puedo ayudar hoy? 💡`,
    fr: `👋 **Bonjour ! Je suis EduBot**, votre assistant IA pour EduMatrix Master.\n\nJe peux vous aider à :\n- 📝 **Imprimer des fiches :** Créer des fiches d'exercices PDF avec corrigés.\n- 📲 **Partager sur WhatsApp :** Envoyer des devoirs et quiz directement.\n- 📊 **Suivi des scores :** Consulter les progrès et bulletins de notes.\n- 🧮 **Résolution de maths :** Explications étape par étape.\n\nComment puis-je vous aider aujourd'hui ? 💡`,
    ar: `👋 **مرحباً! أنا EduBot**، مساعد الذكاء الاصطناعي لتطبيق EduMatrix Master.\n\nيمكنني مساعدتك في:\n- 📝 **طباعة أوراق العمل:** إنشاء أوراق عمل PDF قابلة للطباعة مع نماذج الإجابة.\n- 📲 **المشاركة عبر واتساب:** إرسال الاختبارات والواجبات للطلاب مباشرة.\n- 📊 **متابعة التقدم:** استعراض الشهادات ودرجات الطلاب.\n- 🧮 **حل مسائل الرياضيات:** خطوات حل مفصلة ومبسطة.\n\nكيف يمكنني مساعدتك اليوم؟ 💡`,
    ru: `👋 **Здравствуйте! Я EduBot**, ваш AI-помощник в EduMatrix Master.\n\nЯ могу помочь вам:\n- 📝 **Печать заданий:** Создавать PDF-листы с ответами для печати.\n- 📲 **Отправка в WhatsApp:** Делиться викторинами с учениками.\n- 📊 **Успеваемость:** Проверять баллы, награды и сертификаты.\n- 🧮 **Решение задач:** Пошаговые математические объяснения.\n\nЧем я могу вам помочь сегодня? 💡`,
    nl: `👋 **Hallo! Ik ben EduBot**, jouw AI-assistent voor EduMatrix Master.\n\nIk kan je helpen met:\n- 📝 **Werkbladen afdrukken:** PDF-oefenbladen maken met antwoordsleutels.\n- 📲 **Delen via WhatsApp:** Quizopdrachten direct doorsturen.\n- 📊 **Voortgang & Rapporten:** Scores en certificaten bekijken.\n- 🧮 **Wiskundevragen:** Stap-voor-stap uitleg bij elke berekening.\n\nWaarmee kan ik je helpen? 💡`,
    pt: `👋 **Olá! Sou o EduBot**, seu assistente de IA no EduMatrix Master.\n\nPosso ajudar você a:\n- 📝 **Imprimir Atividades:** Criar folhas de exercícios em PDF com gabarito.\n- 📲 **Compartilhar no WhatsApp:** Enviar tarefas e códigos de quiz aos alunos.\n- 📊 **Acompanhar Notas:** Ver relatórios de desempenho e certificados.\n- 🧮 **Resolver Contas:** Passo a passo para qualquer cálculo de matemática.\n\nComo posso te ajudar hoje? 💡`,
    ms: `👋 **Helo! Saya EduBot**, pembantu AI EduMatrix Master anda.\n\nSaya boleh membantu anda dengan:\n- 📝 **Mencetak Lembaran Kerja:** Menjana PDF lembaran kerja bersama skema jawapan.\n- 📲 **Perkongsian WhatsApp:** Menghantar tugasan kuiz kepada pelajar.\n- 📊 **Pemantauan Skor:** Semak laporan kemajuan dan sijil.\n- 🧮 **Penyelesaian Matematik:** Panduan langkah demi langkah untuk setiap soalan.\n\nApa yang boleh saya bantu hari ini? 💡`,
    ja: `👋 **こんにちは！EduMatrix MasterのAIアシスタントEduBotです。**\n\n以下のサポートが可能です:\n- 📝 **ワークシートの印刷:** 解答付きのPDF練習プリントを作成・印刷。\n- 📲 **WhatsApp共有:** 生徒や保護者にクイズの課題コードを送信。\n- 📊 **成績・進捗確認:** スコアレポートや修了証の確認。\n- 🧮 **算数の質問:** 丁寧なステップ解説と計算のコツ。\n\nどのような質問でもお気軽にどうぞ！💡`
  };
  return dict[lang] || `👋 **Hello! I am EduBot**, your AI Assistant for EduMatrix Master.\n\nI can help you with:\n- 📝 **Worksheets:** Generating and printing custom math worksheets with answer keys.\n- 📲 **WhatsApp Sharing:** Sending quiz assignments directly to students or parents.\n- 📊 **Progress & Scores:** Checking report cards, accuracy badges, and stars.\n- 🧮 **Math Problem-Solving:** Answering math questions with clear step-by-step guidance.\n\nHow can I support you today? 💡`;
}

function getLocalizedWorksheetGuide(lang: string): string {
  const dict: Record<string, string> = {
    ta: `📄 **EduMatrix Master-ல் பயிற்சி தாள்களை அச்சிட்டு PDF ஆக சேமிப்பது எப்படி:**\n\n1. **வகுப்பு மற்றும் கணித செயல்பாடு:** மேல் பகுதியில் உங்கள் வகுப்பு (1 முதல் 8 வரை) மற்றும் கணித செயல்பாட்டை (கூட்டல், பெருக்கல் போன்றவை) தேர்வு செய்யவும்.\n2. **பயிற்சி தாள் பிரிவு:** **Worksheet View** என்பதை கிளிக் செய்யவும் அல்லது **"Generate Printable Worksheet"** பொத்தானை அழுத்தவும்.\n3. **விருப்பங்கள்:** வினாக்களின் எண்ணிக்கை (10 முதல் 100 வரை), பள்ளி பெயர் மற்றும் விடைக்குறிப்பு அமைப்புகளை தேர்வு செய்யவும்.\n4. **அச்சிடுதல் / PDF:** **"Print / Save as PDF"** பொத்தானை அழுத்தி உடனடியாக அச்சிடலாம் அல்லது உங்கள் சாதனத்தில் PDF ஆக பதிவிறக்கலாம்! 🖨️✨`,
    hi: `📄 **EduMatrix Master में वर्कशीट प्रिंट और PDF डाउनलोड करने का तरीका:**\n\n1. **कक्षा और विषय चुनें:** सबसे ऊपर अपनी कक्षा (1st से 8th) और गणित संक्रिया (जोड़, गुणा आदि) चुनें।\n2. **वर्कशीट टैब:** **Worksheet View** पर क्लिक करें या **"Generate Printable Worksheet"** दबाएं।\n3. **कस्टमाइज करें:** प्रश्नों की संख्या (10 से 100), स्कूल का नाम और उत्तर कुंजी (Answer Key) सेट करें।\n4. **प्रिंट करें:** **"Print / Save as PDF"** पर क्लिक करके सीधे प्रिंट करें या पीडीएफ के रूप में सेव करें! 🖨️✨`,
    ml: `📄 **വർക്ക്‌ഷീറ്റ് എങ്ങനെ പ്രിന്റ് ചെയ്യാം / PDF ആയി സേവ് ചെയ്യാം:**\n\n1. **ക്ലാസും പ്രവർത്തനവും:** മുകളിലെ ബാറിൽ നിന്ന് ക്ലാസും ഗണിത പ്രവർത്തനവും (ഗുണനം, സങ്കലനം തുടങ്ങിയവ) തിരഞ്ഞെടുക്കുക.\n2. **വർക്ക്‌ഷീറ്റ് വ്യൂ:** **Worksheet View** ക്ലിക്ക് ചെയ്യുക അല്ലെങ്കിൽ **"Generate Printable Worksheet"** അമർത്തുക.\n3. **ക്രമീകരണങ്ങൾ:** ചോദ്യങ്ങളുടെ എണ്ണം, സ്കൂൾ പേര്, ഉത്തരസൂചിക എന്നിവ ക്രമീകരിക്കുക.\n4. **പ്രിന്റ്:** **"Print / Save as PDF"** ക്ലിക്ക് ചെയ്ത് പ്രിന്റ് എടുക്കുകയോ സേവ് ചെയ്യുകയോ ചെയ്യാം! 🖨️✨`,
    te: `📄 **వర్క్‌షీట్ ప్రింట్ చేయడం మరియు PDF సేవ్ చేయడం ఎలా:**\n\n1. **తరగతి & ఆపరేషన్:** పైన మీ తరగతి (1 నుండి 8) మరియు సంకలనం/గుణకారం ఎంచుకోండి.\n2. **వర్క్‌షీట్ ట్యాబ్:** **Worksheet View** పై క్లిక్ చేయండి లేదా **"Generate Printable Worksheet"** నొక్కండి.\n3. **అనుకూలీకరణ:** ప్రశ్నల సంఖ్య (10-100), స్కూల్ పేరు మరియు సమాధాన కీని ఎంచుకోండి.\n4. **ప్రింట్:** **"Print / Save as PDF"** క్లిక్ చేసి వెంటనే ప్రింట్ లేదా డౌన్‌లోడ్ చేసుకోండి! 🖨️✨`,
    kn: `📄 **ವರ್ಕ್‌ಶೀಟ್ ಪ್ರಿಂಟ್ ಮತ್ತು PDF ಡೌನ್‌ಲೋಡ್ ಮಾಡುವ ವಿಧಾನ:**\n\n1. **ತರಗತಿ ಆಯ್ಕೆ:** ಮೇಲ್ಭಾಗದಲ್ಲಿ ತರಗತಿ (1 ರಿಂದ 8) ಮತ್ತು ಗಣಿತ ಕ್ರಿಯೆಯನ್ನು ಆರಿಸಿ.\n2. **ವರ್ಕ್‌ಶೀಟ್ ಟ್ಯಾಬ್:** **Worksheet View** ಕ್ಲಿಕ್ ಮಾಡಿ ಅಥವಾ **"Generate Printable Worksheet"** ಒತ್ತಿ.\n3. **ಸೆಟ್ಟಿಂಗ್ಸ್:** ಪ್ರಶ್ನೆಗಳ ಸಂಖ್ಯೆ (10-100), ಶಾಲೆಯ ಹೆಸರು ಮತ್ತು ಉತ್ತರ ಪಟ್ಟಿಯನ್ನು ಹೊಂದಿಸಿ.\n4. **ಪ್ರಿಂಟ್:** **"Print / Save as PDF"** ಕ್ಲಿಕ್ ಮಾಡಿ ಪ್ರಿಂಟ್ ಮಾಡಿ ಅಥವಾ ಡೌನ್‌ಲೋಡ್ ಮಾಡಿ! 🖨️✨`,
    zh: `📄 **如何生成并打印数学练习工作表（PDF）：**\n\n1. **选择年级与运算：** 在顶部导航栏选择学生所在年级（1-8年级）以及运算类型（如乘法、除法）。\n2. **生成工作表：** 点击 **Worksheet View** 或 **"Generate Printable Worksheet"** 按钮。\n3. **自定义设置：** 自由调整题目数量（10-100题）、学校校名抬头以及是否附带答案解析。\n4. **打印与导出：** 点击 **"Print / Save as PDF"** 即可一键直接打印或保存为高清 PDF 文件！🖨️✨`,
    es: `📄 **Cómo generar e imprimir hojas de ejercicios en PDF:**\n\n1. **Seleccionar Grado y Operación:** Elige el nivel (1º a 8º) y la operación (Suma, Multiplicación, etc.) arriba.\n2. **Generar Hoja:** Haz clic en **Worksheet View** o pulsa **"Generate Printable Worksheet"**.\n3. **Personalizar:** Ajusta la cantidad de preguntas (10 a 100), el nombre del colegio y la hoja de respuestas.\n4. **Imprimir:** Haz clic en **"Print / Save as PDF"** para imprimir o descargar en PDF al instante. 🖨️✨`,
    fr: `📄 **Comment générer et imprimer des fiches d'exercices en PDF :**\n\n1. **Sélectionner le niveau :** Choisissez la classe (1ère à 8ème) et l'opération en haut.\n2. **Affichage fiche :** Cliquez sur **Worksheet View** ou **"Generate Printable Worksheet"**.\n3. **Options :** Personnalisez le nombre de questions (10 à 100), l'en-tête d'école et les corrigés.\n4. **Imprimer :** Cliquez sur **"Print / Save as PDF"** pour exporter ou imprimer immédiatement ! 🖨️✨`,
    ar: `📄 **كيفية إنشاء وطباعة أوراق العمل بصيغة PDF:**\n\n1. **اختيار الصف والعملية:** حدد الصف الدراسي (من الأول إلى الثامن) والعملية الحسابية في الشريط العلوي.\n2. **توليد ورقة العمل:** اضغط على **Worksheet View** أو زر **"Generate Printable Worksheet"**.\n3. **تخصيص الإعدادات:** اختر عدد الأسئلة (من 10 إلى 100)، اسم المدرسة، وإرفاق ورقة الإجابات.\n4. **الطباعة والحفظ:** اضغط على **"Print / Save as PDF"** للطباعة أو التنزيل فوراً! 🖨️✨`,
    ru: `📄 **Как распечатать и сохранить рабочий лист в PDF:**\n\n1. **Выбор класса и темы:** Выберите класс (1-8) и операцию (умножение, деление и т.д.) вверху.\n2. **Генерация листа:** Нажмите **Worksheet View** или кнопку **"Generate Printable Worksheet"**.\n3. **Настройки:** Укажите количество заданий (10-100), название школы и ключ с ответами.\n4. **Печать:** Нажмите **"Print / Save as PDF"** для мгновенной печати или экспорта в PDF! 🖨️✨`,
    nl: `📄 **Hoe werkbladen te genereren en als PDF af te drukken:**\n\n1. **Kies klas en bewerking:** Selecteer het leerjaar (1-8) en de gewenste rekenbewerking bovenaan.\n2. **Werkbladweergave:** Klik op **Worksheet View** of **"Generate Printable Worksheet"**.\n3. **Aanpassen:** Kies het aantal vragen (10 tot 100), schoolnaam en antwoordsleutel.\n4. **Afdrukken:** Klik op **"Print / Save as PDF"** om direct af te drukken of te downloaden! 🖨️✨`,
    pt: `📄 **Como gerar e imprimir folhas de exercícios em PDF:**\n\n1. **Escolha a Série e Operação:** Selecione a série (1º ao 8º) e a operação matemática no topo.\n2. **Gerar Atividade:** Clique na aba **Worksheet View** ou em **"Generate Printable Worksheet"**.\n3. **Personalizar:** Ajuste o número de questões (10 a 100), o nome da escola e o gabarito.\n4. **Imprimir:** Clique em **"Print / Save as PDF"** para imprimir ou salvar como PDF! 🖨️✨`,
    ms: `📄 **Cara Menjana & Mencetak Lembaran Kerja PDF:**\n\n1. **Pilih Gred & Operasi:** Pilih darjah/tingkatan (1 hingga 8) dan operasi matematik di bar atas.\n2. **Jana Lembaran:** Klik tab **Worksheet View** atau **"Generate Printable Worksheet"**.\n3. **Ubah Suai:** Tetapkan bilangan soalan (10-100), nama sekolah dan skema jawapan.\n4. **Cetak:** Klik **"Print / Save as PDF"** untuk mencetak atau memuat turun PDF! 🖨️✨`,
    ja: `📄 **ワークシートを作成してPDF印刷する方法:**\n\n1. **学年と計算を選ぶ:** 画面上部で学年（1〜8年生）と計算の種類（掛け算・割り算など）を選択します。\n2. **ワークシート画面:** **Worksheet View** または **「Generate Printable Worksheet」** を押します。\n3. **カスタマイズ:** 問題数（10〜100問）、学校名、解答欄の有無を設定します。\n4. **印刷・保存:** **「Print / Save as PDF」** をクリックすると、直接印刷またはPDFとして保存できます！🖨️✨`
  };
  return dict[lang] || `📄 **How to Print & Download Worksheets in EduMatrix Master:**\n\n1. Select your target **Grade/Standard** and **Operation** (e.g. Multiplication, Addition).\n2. Click on the **Worksheet View** tab or press **"Generate Printable Worksheet"**.\n3. Customize the number of questions, school header, and answer key settings.\n4. Click **"Print / Save as PDF"** to print or export directly to your device! 🖨️`;
}

function getLocalizedWhatsAppGuide(lang: string): string {
  const dict: Record<string, string> = {
    ta: `📲 **வாட்ஸ்அப் மூலம் வினாடி வினாக்களை மாணவர்களுடன் பகிர்வது எப்படி:**\n\n1. **ஆசிரியர் அல்லது பெற்றோர் முறை:** மேல் மெனுவில் ஆசிரியர் (Teacher) அல்லது பெற்றோர் (Parent) பயன்முறையை தேர்வு செய்யவும்.\n2. **பகிர்வு பொத்தான்:** வினாடி வினா அல்லது தாள் பகுதியில் உள்ள பச்சை நிற **"Share Quiz"** பொத்தானை அழுத்தவும்.\n3. **தானியங்கி செய்தி:** வினாடி வினா விவரங்கள் மற்றும் பிரத்யேக குறியீட்டுடன் கூடிய வாட்ஸ்அப் செய்தி தானாக தோன்றும்.\n4. **அனுப்புதல்:** உங்கள் வகுப்பு குழு அல்லது பெற்றோர் தொடர்பை தேர்வு செய்து அனுப்பவும்! மாணவர்கள் அந்த இணைப்பை கிளிக் செய்து உடனடியாக பயிற்சியைத் தொடங்கலாம். 🎯`,
    hi: `📲 **व्हाट्सएप के जरिए क्विज असाइनमेंट शेयर करने का तरीका:**\n\n1. **टीचर या पैरेंट मोड:** ऊपर टीचर या पैरेंट मोड चुनें।\n2. **शेयर बटन:** क्विज सेक्शन में हरे रंग के **"Share Quiz"** बटन पर क्लिक करें।\n3. **ऑटोमैटिक मैसेज:** क्विज लिंक और कोड के साथ व्हाट्सएप चैट अपने आप खुल जाएगी।\n4. **सेंड करें:** अपने क्लास ग्रुप या पैरेंट्स को भेजें! छात्र लिंक खोलकर तुरंत टेस्ट दे सकते हैं। 🎯`,
    ml: `📲 **വാട്ട്‌സ്ആപ്പിലൂടെ ക്വിസ് എങ്ങനെ അയക്കാം:**\n\n1. **ടീച്ചർ/പാരന്റ് മോഡ്:** മുകളിൽ ടീച്ചർ അല്ലെങ്കിൽ പാരന്റ് മോഡ് തിരഞ്ഞെടുക്കുക.\n2. **ഷെയർ ബട്ടൺ:** പച്ചനിറത്തിലുള്ള **"Share Quiz"** ബട്ടൺ അമർത്തുക.\n3. **സന്ദേശം:** ക്വിസ് ലിങ്കും കോഡുമുള്ള വാട്ട്‌സ്ആപ്പ് മെസ്സേജ് തുറന്നുവരും.\n4. **അയക്കുക:** നിങ്ങളുടെ ക്ലാസ് ഗ്രൂപ്പിലേക്ക് അയക്കുക! വിദ്യാർത്ഥികൾക്ക് എളുപ്പത്തിൽ പങ്കെടുക്കാം. 🎯`,
    te: `📲 **వాట్సాప్ ద్వారా క్విజ్ ఎలా పంపాలి:**\n\n1. **టీచర్/పేరెంట్ మోడ్:** పైన టీచర్ లేదా పేరెంట్ మోడ్ ఎంచుకోండి.\n2. **షేర్ బటన్:** ఆకుపచ్చ రంగు **"Share Quiz"** బటన్‌పై క్లిక్ చేయండి.\n3. **మెసేజ్:** క్విజ్ కోడ్ మరియు లింక్‌తో వాట్సాప్ ఓపెన్ అవుతుంది.\n4. **సెండ్:** మీ క్లాస్ గ్రూప్‌కు సెండ్ చేయండి! విద్యార్థులు నేరుగా పరీక్ష రాయవచ్చు. 🎯`,
    kn: `📲 **ವಾಟ್ಸಾಪ್ ಮೂಲಕ ಕ್ವಿಜ್ ಹಂಚಿಕೊಳ್ಳುವ ವಿಧಾನ:**\n\n1. **ಶಿಕ್ಷಕರ/ಪೋಷಕರ ಮೋಡ್:** ಮೇಲ್ಭಾಗದಲ್ಲಿ Teacher ಅಥವಾ Parent ಮೋಡ್ ಆಯ್ಕೆಮಾಡಿ.\n2. **ಹಂಚಿಕೆ ಬಟನ್:** ಹಸಿರು ಬಣ್ಣದ **"Share Quiz"** ಬಟನ್ ಒತ್ತಿ.\n3. **ಸಂದೇಶ:** ಕ್ವಿಜ್ ಲಿಂಕ್‌ನೊಂದಿಗೆ ವಾಟ್ಸಾಪ್ ತೆರೆಯುತ್ತದೆ.\n4. **ಕಳುಹಿಸಿ:** ನಿಮ್ಮ ಕ್ಲಾಸ್ ಗ್ರೂಪ್‌ಗೆ ಕಳುಹಿಸಿ! ವಿದ್ಯಾರ್ಥಿಗಳು ತಕ್ಷಣ ಪರೀಕ್ಷೆ ತೆಗೆದುಕೊಳ್ಳಬಹುದು. 🎯`,
    zh: `📲 **如何通过 WhatsApp / 社交渠道分享测验：**\n\n1. **切换角色：** 在顶部切换为 **Teacher（教师）** 或 **Parent（家长）** 模式。\n2. **点击分享：** 点击测验或工作表区域的绿色 **"Share Quiz"** 按钮。\n3. **自动生成消息：** 系统将自动生成包含作业详情和专属测验代码的消息。\n4. **发送给班级：** 选择班级群组发送，学生点击链接即可直接进入练习！🎯`,
    es: `📲 **Cómo compartir cuestionarios por WhatsApp:**\n\n1. **Modo Profesor o Padre:** Activa el modo Profesor o Padre en la barra superior.\n2. **Botón Compartir:** Haz clic en el botón verde **"Share Quiz"**.\n3. **Mensaje Automático:** Se generará un enlace directo con el código del cuestionario.\n4. **Enviar:** Selecciona el grupo de clase de WhatsApp y ¡listo para practicar! 🎯`,
    fr: `📲 **Comment partager des quiz via WhatsApp :**\n\n1. **Mode Enseignant ou Parent :** Activez le profil Enseignant ou Parent.\n2. **Bouton Partager :** Cliquez sur le bouton vert **"Share Quiz"**.\n3. **Lien direct :** Un message automatique avec le code du devoir s'affiche.\n4. **Envoyer :** Partagez-le avec vos élèves sur WhatsApp ! 🎯`,
    ar: `📲 **كيفية مشاركة الاختبارات عبر واتساب:**\n\n1. **وضع المعلم أو ولي الأمر:** اختر وضع المعلم أو ولي الأمر من القائمة.\n2. **زر المشاركة:** اضغط على زر **"Share Quiz"** الأخضر.\n3. **رسالة مخصصة:** سيتم تجهيز رسالة تحتوي على رابط وكود الاختبار تلقائياً.\n4. **الإرسال:** أرسلها لمجموعة الفصل على واتساب ليبدأ الطلاب التدريب فوراً! 🎯`,
    ru: `📲 **Как отправить викторину в WhatsApp:**\n\n1. **Режим учителя или родителя:** Переключитесь в режим Teacher или Parent.\n2. **Кнопка «Поделиться»:** Нажмите зеленую кнопку **"Share Quiz"**.\n3. **Сообщение с кодом:** Автоматически сформируется ссылка с кодом задания.\n4. **Отправка:** Отправьте в классный чат WhatsApp, и ученики смогут сразу начать тест! 🎯`,
    nl: `📲 **Quiz delen via WhatsApp:**\n\n1. **Docent- of Oudermodus:** Schakel over naar de Teacher of Parent rol.\n2. **Deelknop:** Klik op de groene knop **"Share Quiz"**.\n3. **Automatisch bericht:** Er opent een bericht met de directe opdrachtcode.\n4. **Versturen:** Deel het in de klassengroep en leerlingen kunnen meteen starten! 🎯`,
    pt: `📲 **Como compartilhar quizzes pelo WhatsApp:**\n\n1. **Modo Professor ou Responsável:** Ative o modo Professor ou Parent.\n2. **Botão Compartilhar:** Clique no botão verde **"Share Quiz"**.\n3. **Mensagem Pronta:** Uma mensagem com o código do quiz será gerada.\n4. **Enviar:** Envie no grupo da turma para os alunos responderem online! 🎯`,
    ms: `📲 **Cara Kongsi Kuiz Melalui WhatsApp:**\n\n1. **Mod Guru atau Ibu Bapa:** Pilih mod Teacher atau Parent di menu atas.\n2. **Butang Kongsi:** Tekan butang hijau **"Share Quiz"**.\n3. **Mesej Automatik:** Mesej bersama pautan dan kod kuiz akan dijana.\n4. **Hantar:** Hantar ke kumpulan WhatsApp kelas untuk pelajar menjawab! 🎯`,
    ja: `📲 **WhatsAppでクイズ課題を共有する方法:**\n\n1. **先生・保護者モード:** 上部で「Teacher」または「Parent」モードを選択します。\n2. **共有ボタン:** 緑色の **「Share Quiz」** ボタンをクリックします。\n3. **自動メッセージ:** 課題コードとアクセスリンクが含まれたメッセージが生成されます。\n4. **送信:** クラスのWhatsAppグループに送信すれば、生徒がワンタップでテストを開始できます！🎯`
  };
  return dict[lang] || `📲 **How to Share Quizzes on WhatsApp:**\n\n1. In **Teacher** or **Parent** mode, click the green **"Share Quiz"** button on the worksheet/quiz section.\n2. A custom WhatsApp message containing the quiz details and standard assignment code will automatically open.\n3. Choose your class group or parent contact on WhatsApp and press Send!\n4. Students can click the link or enter the code to take the exact assignment online. 🎯`;
}

function getLocalizedScoreGuide(lang: string): string {
  const dict: Record<string, string> = {
    ta: `📊 **மதிப்பெண்கள், முன்னேற்றம் மற்றும் சான்றிதழ் விவரங்கள்:**\n\n- **உடனடி மதிப்பெண்:** வினாடி வினாவை முடித்த பிறகு, **"Check My Score!"** பொத்தானை அழுத்தி உங்கள் சதவீத மதிப்பெண் மற்றும் செலவழித்த நேரத்தை பார்க்கலாம்.\n- **முழு அறிக்கை அட்டை:** **"View Full Report Card"** என்பதை கிளிக் செய்து பெற்றோர் மற்றும் ஆசிரியர் கையொப்பமிடக்கூடிய அச்சிடத்தக்க சான்றிதழைப் பெறலாம்!\n- **நட்சத்திர பேட்ஜ்கள்:** சிறந்த துல்லியத்திற்கு சிறப்பு பேட்ஜ்கள் மற்றும் விருதுகள் வழங்கப்படும்! 🏆⭐`,
    hi: `📊 **स्कोर, प्रगति और रिपोर्ट कार्ड कैसे देखें:**\n\n- **तुरंत स्कोर:** क्विज पूरा करने के बाद **"Check My Score!"** दबाएं और अपना प्रतिशत व समय देखें।\n- **फुल रिपोर्ट कार्ड:** **"View Full Report Card"** पर क्लिक करके पैरेंट और टीचर सिग्नेचर वाला प्रिंट करने योग्य सर्टिफिकेट प्राप्त करें!\n- **स्टार बैज:** उच्च सटीकता के लिए विशेष स्टार बैज और पुरस्कार मिलते हैं! 🏆⭐`,
    ml: `📊 **സ്കോറുകളും പുരോഗതി റിപ്പോർട്ടുകളും:**\n\n- **സ്കോർ പരിശോധന:** ക്വിസ് പൂർത്തിയായ ശേഷം **"Check My Score!"** അമർത്തുക.\n- **റിപ്പോർട്ട് കാർഡ്:** **"View Full Report Card"** വഴി ഒപ്പിട്ട പ്രിന്റബിൾ സർട്ടിഫിക്കറ്റ് ലഭിക്കും.\n- **സ്റ്റാർ ബാഡ്ജുകൾ:** മികച്ച പ്രകടനത്തിന് പ്രത്യേക അവാർഡുകൾ നേടാം! 🏆⭐`,
    te: `📊 **స్కోర్లు మరియు ప్రోగ్రెస్ రిపోర్ట్ చూడటం:**\n\n- **స్కోర్ చెక్:** క్విజ్ ముగిసిన తర్వాత **"Check My Score!"** నొక్కి మీ శాతాన్ని చూడండి.\n- **రిపోర్ట్ కార్డ్:** **"View Full Report Card"** క్లిక్ చేసి సంతకంతో కూడిన సర్టిఫికెట్ ప్రింట్ చేయండి!\n- **స్టార్ బ్యాడ్జీలు:** అద్భుతమైన ప్రదర్శనకు స్టార్ రివార్డులు లభిస్తాయి! 🏆⭐`,
    kn: `📊 **ಅಂಕಗಳು ಮತ್ತು ಪ್ರಗತಿ ಪರಿಶೀಲನೆ:**\n\n- **ಅಂಕ ಪರಿಶೀಲನೆ:** ಕ್ವಿಜ್ ಮುಗಿದ ನಂತರ **"Check My Score!"** ಒತ್ತಿ ನಿಮ್ಮ ಫಲಿತಾಂಶ ನೋಡಿ.\n- **ಪ್ರಗತಿ ಪತ್ರ:** **"View Full Report Card"** ಮೂಲಕ ಪ್ರಮಾಣಪತ್ರ ಪ್ರಿಂಟ್ ಮಾಡಿ!\n- **ಸ್ಟಾರ್ ಬ್ಯಾಡ್ಜ್‌ಗಳು:** ನಿಖರತೆಗೆ ವಿಶೇಷ ಬಹುಮಾನಗಳು ದೊರೆಯುತ್ತವೆ! 🏆⭐`,
    zh: `📊 **查看成绩、排行榜与综合报告单：**\n\n- **即时得分：** 完成测验后点击 **"Check My Score!"**，即可立即查看正确率百分比和用时。\n- **完整成绩单与证书：** 点击 **"View Full Report Card"**，可生成包含家长与教师签字栏的高清打印奖状。\n- **成就勋章：** 满分或优异表现将解锁专属星星勋章！🏆⭐`,
    es: `📊 **Revisión de puntuaciones y reportes de progreso:**\n\n- **Puntuación inmediata:** Al terminar el test, pulsa **"Check My Score!"** para ver tu porcentaje y tiempo.\n- **Boletín y Certificado:** Haz clic en **"View Full Report Card"** para generar un diploma imprimible con firmas.\n- **Insignias y Estrellas:** ¡Gana medallas por máxima precisión! 🏆⭐`,
    fr: `📊 **Consultation des scores et bulletins de progression :**\n\n- **Score immédiat :** Cliquez sur **"Check My Score!"** après le quiz pour voir votre pourcentage.\n- **Certificat imprimable :** Cliquez sur **"View Full Report Card"** pour un bulletin avec signatures.\n- **Badges et étoiles :** Obtenez des récompenses pour votre précision ! 🏆⭐`,
    ar: `📊 **الاطلاع على الدرجات وشهادات التقدير:**\n\n- **النتيجة الفورية:** بعد إنهاء الاختبار، اضغط **"Check My Score!"** لمعرفة النسبة المئوية والوقت.\n- **التقرير الشامل:** اضغط **"View Full Report Card"** لطباعة شهادة تقدير مع خانات التوقيع.\n- **أوسمة النجوم:** احصل على ميداليات التميز عند تحقيق درجات عالية! 🏆⭐`,
    ru: `📊 **Проверка оценок и табеля успеваемости:**\n\n- **Мгновенный результат:** После викторины нажмите **"Check My Score!"**, чтобы увидеть процент и время.\n- **Сертификат:** Нажмите **"View Full Report Card"** для печати табеля с подписями.\n- **Звездные значки:** Получайте награды за высокую точность! 🏆⭐`,
    nl: `📊 **Scores en voortgangsrapporten bekijken:**\n\n- **Directe score:** Klik na de quiz op **"Check My Score!"** voor je percentage en tijd.\n- **Certificaat:** Klik op **"View Full Report Card"** voor een printbaar certificaat met handtekeningen.\n- **Sterrenbadges:** Verdien medailles voor uitmuntende nauwkeurigheid! 🏆⭐`,
    pt: `📊 **Consulta de pontuações e relatórios de progresso:**\n\n- **Resultado imediato:** Clique em **"Check My Score!"** após o quiz para ver sua porcentagem.\n- **Certificado:** Clique em **"View Full Report Card"** para gerar um boletim impresso com assinaturas.\n- **Medalhas de Estrela:** Ganhe prêmios por alta precisão nos cálculos! 🏆⭐`,
    ms: `📊 **Semakan Skor & Laporan Kemajuan:**\n\n- **Skor Segera:** Selepas selesai kuiz, klik **"Check My Score!"** untuk melihat peratusan dan masa.\n- **Kad Laporan:** Klik **"View Full Report Card"** untuk menjana sijil boleh cetak dengan tandatangan.\n- **Lencana Bintang:** Dapatkan ganjaran bintang untuk ketepatan tertinggi! 🏆⭐`,
    ja: `📊 **スコア確認と学習レポートカード:**\n\n- **即時スコア:** クイズ終了後に **「Check My Score!」** を押すと、正解率と所要時間が表示されます。\n- **修了証・レポートカード:** **「View Full Report Card」** をクリックすると、保護者・先生のサイン欄付きの修了証を発行できます。\n- **スターバッジ:** 高得点を獲得して限定バッジを集めましょう！🏆⭐`
  };
  return dict[lang] || `📊 **Checking Scores & Progress Reports:**\n\n- After finishing a quiz session, click **"Check My Score!"** to see your immediate percentage score, time spent, and performance breakdown.\n- Click **"View Full Report Card"** to generate a printable performance certificate.\n- Teachers and parents can review total accuracy badges and star rewards! 🌟`;
}

function getLocalizedMathTricks(lang: string): string {
  const dict: Record<string, string> = {
    ta: `💡 **எளிய கணித குறுக்கு வழிகள் (Speed Math Tricks):**\n\n1. **9-ஆல் பெருக்கும் குறுக்கு வழி:**\n   - எண் × 9 செய்ய, அந்த எண்ணுடன் 10-ஐப் பெருக்கி, அதே எண்ணைக் கழிக்கவும்.\n   - *எடுத்துக்காட்டு:* 8 × 9 = (8 × 10) - 8 = 80 - 8 = **72**!\n2. **5-ல் முடியும் எண்களின் வர்க்கம் (Square of numbers ending in 5):**\n   - 25² = (2 × 3) மற்றும் 25 = **625**.\n   - 35² = (3 × 4) மற்றும் 25 = **1225**.\n3. **11-ஆல் பெருக்கல் (Multiply by 11):**\n   - 43 × 11 = 4 [4+3] 3 = **473**!\n\nEduMatrix Master-ல் தினமும் பயிற்சி செய்து உங்கள் வேகத்தை அதிகரியுங்கள்! 🚀`,
    hi: `💡 **आसान गणित ट्रिक्स (Speed Math Tricks):**\n\n1. **9 से गुणा करने की ट्रिक:**\n   - किसी संख्या को 9 से गुणा करने के लिए उसे 10 से गुणा करें और मूल संख्या घटा दें।\n   - *उदाहरण:* 7 × 9 = (7 × 10) - 7 = 70 - 7 = **63**!\n2. **5 पर समाप्त होने वाली संख्याओं का वर्ग:**\n   - 25² = (2 × 3) और 25 = **625**।\n   - 45² = (4 × 5) और 25 = **2025**।\n3. **11 से आसान गुणा:**\n   - 35 × 11 = 3 [3+5] 5 = **385**!\n\nEduMatrix Master में रोजाना अभ्यास करें और अपनी गति बढ़ाएं! 🚀`,
    ml: `💡 **എളുപ്പമുള്ള കണക്ക് ട്രിക്കുകൾ:**\n\n1. **9 കൊണ്ടുള്ള ഗുണനം:**\n   - സംഖ്യയെ 10 കൊണ്ട് ഗുണിച്ച് അതേ സംഖ്യ കുറയ്ക്കുക.\n   - *ഉദാഹരണം:* 6 × 9 = 60 - 6 = **54**!\n2. **5-ൽ അവസാനിക്കുന്ന സംഖ്യകളുടെ വർഗ്ഗം:**\n   - 25² = (2 × 3) കൂടാതെ 25 = **625**.\n3. **11 കൊണ്ടുള്ള ഗുണനം:**\n   - 52 × 11 = 5 [5+2] 2 = **572**!\n\nEduMatrix Master-ൽ ദിവസവും പരിശീലിക്കൂ! 🚀`,
    te: `💡 **సులభమైన గణిత ట్రిక్స్:**\n\n1. **9 తో గుణకారం:**\n   - సంఖ్యను 10 తో గుణించి అదే సంఖ్యను తీసివేయండి.\n   - *ఉదాహరణ:* 8 × 9 = 80 - 8 = **72**!\n2. **5 తో ముగిసే సంఖ్యల వర్గం:**\n   - 35² = (3 × 4) మరియు 25 = **1225**.\n3. **11 తో గుణకారం:**\n   - 45 × 11 = 4 [4+5] 5 = **495**!\n\nరోజూ సాధన చేసి వేగాన్ని పెంచుకోండి! 🚀`,
    kn: `💡 **ಸುಲಭ ಗಣಿತ ತಂತ್ರಗಳು:**\n\n1. **9 ರ ಗುಣಾಕಾರ ತಂತ್ರ:**\n   - ಸಂಖ್ಯೆಯನ್ನು 10 ರಿಂದ ಗುಣಿಸಿ ಅದೇ ಸಂಖ್ಯೆಯನ್ನು ಕಳೆಯಿರಿ.\n   - *ಉದಾಹರಣೆ:* 7 × 9 = 70 - 7 = **63**!\n2. **5 ರಲ್ಲಿ ಕೊನೆಗೊಳ್ಳುವ ವರ್ಗ:**\n   - 25² = (2 × 3) ಮತ್ತು 25 = **625**.\n3. **11 ರ ಗುಣಾಕಾರ:**\n   - 34 × 11 = 3 [3+4] 4 = **374**!\n\nನಿತ್ಯ ಅಭ್ಯಾಸ ಮಾಡಿ ಗಣಿತದಲ್ಲಿ ಪ್ರವೀಣರಾಗಿ! 🚀`,
    zh: `💡 **实用数学速算小技巧（Speed Math Tricks）：**\n\n1. **巧用9的乘法：**\n   - 任何数乘 9，等于该数乘 10 减去它本身。\n   - *例如：* 8 × 9 = (8 × 10) - 8 = 80 - 8 = **72**！\n2. **尾数为5的数字平方：**\n   - 35² = (3 × 4) 拼接 25 = **1225**。\n   - 65² = (6 × 7) 拼接 25 = **4225**。\n3. **两位数乘11速算：**\n   - 53 × 11 = 5 [5+3] 3 = **583**！\n\n在 EduMatrix Master 坚持每日打卡，速算能力翻倍！🚀`,
    es: `💡 **Trucos Rápidos de Matemáticas:**\n\n1. **Multiplicar por 9:**\n   - Multiplica por 10 y resta el número original.\n   - *Ejemplo:* 8 × 9 = 80 - 8 = **72**!\n2. **Cuadrado de números que terminan en 5:**\n   - 35² = (3 × 4) y 25 = **1225**.\n3. **Multiplicar por 11:**\n   - 42 × 11 = 4 [4+2] 2 = **462**!\n\n¡Sigue practicando en EduMatrix Master para ganar velocidad! 🚀`,
    fr: `💡 **Astuces de Calcul Rapide :**\n\n1. **Multiplier par 9 :**\n   - Multipliez par 10 et soustrayez le nombre.\n   - *Exemple :* 7 × 9 = 70 - 7 = **63** !\n2. **Carré des nombres se terminant par 5 :**\n   - 25² = (2 × 3) suivi de 25 = **625**.\n3. **Multiplier par 11 :**\n   - 34 × 11 = 3 [3+4] 4 = **374** !\n\nEntraînez-vous chaque jour sur EduMatrix Master ! 🚀`,
    ar: `💡 **حيل الرياضيات السريعة:**\n\n1. **الضرب في 9 بسهولة:**\n   - اضرب العدد في 10 ثم اطرح العدد الأصلي منه.\n   - *مثال:* 8 × 9 = 80 - 8 = **72**!\n2. **مربع الأعداد المنتهية بالرقم 5:**\n   - 35² = (3 × 4) مع 25 = **1225**.\n3. **الضرب في 11:**\n   - 43 × 11 = 4 [4+3] 3 = **473**!\n\nتدرب يومياً مع EduMatrix Master لتصبح عبقري الرياضيات! 🚀`,
    ru: `💡 **Трюки быстрого счета в уме:**\n\n1. **Умножение на 9:**\n   - Умножьте на 10 и вычтите исходное число.\n   - *Пример:* 8 × 9 = 80 - 8 = **72**!\n2. **Квадрат чисел, оканчивающихся на 5:**\n   - 35² = (3 × 4) и 25 = **1225**.\n3. **Умножение на 11:**\n   - 52 × 11 = 5 [5+2] 2 = **572**!\n\nТренируйтесь регулярно в EduMatrix Master! 🚀`,
    nl: `💡 **Handige Reken-Trucjes:**\n\n1. **Vermenigvuldigen met 9:**\n   - Vermenigvuldig met 10 en trek het getal ervan af.\n   - *Voorbeeld:* 8 × 9 = 80 - 8 = **72**!\n2. **Kwadraat van getallen eindigend op 5:**\n   - 35² = (3 × 4) en 25 = **1225**.\n3. **Vermenigvuldigen met 11:**\n   - 45 × 11 = 4 [4+5] 5 = **495**!\n\nBlijf dagelijks oefenen in EduMatrix Master! 🚀`,
    pt: `💡 **Truques de Cálculo Rápido:**\n\n1. **Multiplicação por 9:**\n   - Multiplique por 10 e subtraia o número original.\n   - *Exemplo:* 8 × 9 = 80 - 8 = **72**!\n2. **Quadrado de números terminados em 5:**\n   - 35² = (3 × 4) e 25 = **1225**.\n3. **Multiplicar por 11:**\n   - 43 × 11 = 4 [4+3] 3 = **473**!\n\nPratique diariamente no EduMatrix Master! 🚀`,
    ms: `💡 **Trik Pantas Matematik:**\n\n1. **Pendaraban dengan 9:**\n   - Darab dengan 10 dan tolak nombor asal.\n   - *Contoh:* 7 × 9 = 70 - 7 = **63**!\n2. **Kuasa dua nombor berakhir dengan 5:**\n   - 25² = (2 × 3) dan 25 = **625**.\n3. **Darab dengan 11:**\n   - 54 × 11 = 5 [5+4] 4 = **594**!\n\nTingkatkan kepantasan anda di EduMatrix Master! 🚀`,
    ja: `💡 **算数の計算スピードアップ裏ワザ:**\n\n1. **9の掛け算のコツ:**\n   - 10倍してから元の数を引きます。\n   - *例:* 8 × 9 = 80 - 8 = **72**！\n2. **一の位が「5」の2乗計算:**\n   - 35² = (3 × 4) に 25 を並べて = **1225**。\n3. **11の掛け算速算:**\n   - 43 × 11 = 4 [4+3] 3 = **473**！\n\nEduMatrix Masterで毎日練習して計算マスターを目指しましょう！🚀`
  };
  return dict[lang] || `💡 **Math Tricks & Tips:**\n\n- **Multiplying by 9:** Multiply by 10 and subtract the original number (e.g., 8 × 9 = 80 - 8 = 72).\n- **Squares ending in 5:** For 35², multiply 3 × 4 = 12 and attach 25 = 1225.\n- **Multiplying by 11:** For 43 × 11, add digits (4+3=7) and place in middle = 473!`;
}

function getLocalizedSettingsGuide(lang: string): string {
  const dict: Record<string, string> = {
    ta: `🌐 **மொழி மற்றும் வகுப்பு அமைப்புகள்:**\n\n- **மொழி மாற்றுதல்:** மேல் வலதுபுறத்தில் உள்ள மொழி கீழ்தோன்றும் மெனுவில் 15 மொழிகளில் (தமிழ், ஆங்கிலம், இந்தி போன்றவை) விரும்பிய மொழியைத் தேர்வு செய்யலாம்.\n- **வகுப்பு மாற்றுதல்:** மேல் பட்டை பட்டியில் **1st Standard முதல் 8th Standard வரை** உங்கள் வகுப்பைத் தேர்வு செய்யலாம். வினாடி வினா கேள்விகள் தானாக உங்கள் வகுப்பு நிலைக்கு ஏற்றவாறு மாறும்! 🎯`,
    hi: `🌐 **भाषा और कक्षा सेटिंग्स:**\n\n- **भाषा बदलें:** ऊपर दाईं ओर दिए गए भाषा ड्रॉपडाउन से अपनी पसंदीदा भाषा (हिन्दी, तमिल, अंग्रेजी आदि) चुनें।\n- **कक्षा बदलें:** ऊपर दिए गए ग्रेड बार से **1st Standard से 8th Standard** चुनें। सभी प्रश्न स्वतः आपकी कक्षा के अनुसार सेट हो जाएंगे! 🎯`,
    ml: `🌐 **ഭാഷയും ക്ലാസും മാറ്റൽ:**\n\n- **ഭാഷ:** മുകളിൽ വലതുവശത്തുള്ള ഡ്രോപ്പ്ഡൗണിൽ നിന്ന് 15 ഭാഷകളിൽ ഒന്ന് തിരഞ്ഞെടുക്കാം.\n- **ക്ലാസ്:** **1 മുതൽ 8 വരെയുള്ള ക്ലാസുകൾ** തിരഞ്ഞെടുത്ത് പഠനം ആരംഭിക്കാം! 🎯`,
    te: `🌐 **భాష మరియు తరగతి మార్పు:**\n\n- **భాష:** పైన కుడివైపు డ్రాప్‌డౌన్ నుండి మీకు నచ్చిన భాషను ఎంచుకోండి.\n- **తరగతి:** **1వ తరగతి నుండి 8వ తరగతి వరకు** ఎంచుకోవచ్చు! 🎯`,
    kn: `🌐 **ಭಾಷೆ ಮತ್ತು ತರಗತಿ ಸೆಟ್ಟಿಂಗ್ಸ್:**\n\n- **ಭಾಷೆ:** ಮೇಲಿನ ಡ್ರಾಪ್‌ಡೌನ್‌ನಿಂದ ನಿಮ್ಮ ಭಾಷೆ ಆರಿಸಿ.\n- **ತರಗತಿ:** **1 ರಿಂದ 8 ನೇ ತರಗತಿ** ಆಯ್ಕೆಮಾಡಿ! 🎯`,
    zh: `🌐 **语言与年级设置说明：**\n\n- **切换语言：** 点击右上角语言下拉菜单，可随时在 15 种全球语言之间无缝切换。\n- **选择年级：** 在顶部年级导航栏中选择 **1年级至8年级**，系统将自动适配该年级的题目难度与知识点！🎯`,
    es: `🌐 **Ajustes de Idioma y Grado:**\n\n- **Cambiar Idioma:** Selecciona tu idioma preferido en el menú superior derecho (15 idiomas).\n- **Cambiar Grado:** Elige entre **1º y 8º Grado** en la barra superior para ajustar la dificultad automáticamente. 🎯`,
    fr: `🌐 **Paramètres de Langue et Classe :**\n\n- **Langue :** Changez de langue dans le menu déroulant en haut à droite (15 langues).\n- **Classe :** Sélectionnez de la **1ère à la 8ème** pour adapter la difficulté des quiz. 🎯`,
    ar: `🌐 **إعدادات اللغة والصف الدراسي:**\n\n- **تغيير اللغة:** اختر لغتك المفضلة من القائمة العلوية اليمنى (15 لغة).\n- **تغيير الصف:** حدد من **الصف الأول حتى الصف الثامن** لتعديل مستوى صعوبة الأسئلة تلقائياً. 🎯`,
    ru: `🌐 **Настройки языка и класса:**\n\n- **Смена языка:** Выберите нужный язык в правом верхнем углу (доступно 15 языков).\n- **Выбор класса:** Выберите с **1 по 8 класс** на верхней панели для автоподбора сложности! 🎯`,
    nl: `🌐 **Taal- en Klasinstellingen:**\n\n- **Taal wijzigen:** Kies jouw gewenste taal in de rechterbovenhoek (15 talen).\n- **Klas kiezen:** Selecteer van **Groep 3 t/m 8 (1st - 8th standard)** om de moeilijkheidsgraad aan te passen. 🎯`,
    pt: `🌐 **Configurações de Idioma e Série:**\n\n- **Mudar Idioma:** Selecione seu idioma no canto superior direito (15 idiomas).\n- **Mudar Série:** Escolha do **1º ao 8º Ano** no topo para ajustar o nível dos exercícios. 🎯`,
    ms: `🌐 **Tetapan Bahasa & Gred:**\n\n- **Tukar Bahasa:** Pilih bahasa di menu atas kanan (15 bahasa).\n- **Pilih Gred:** Pilih **Darjah 1 hingga Tingkatan 2 (1st - 8th Standard)** untuk aras soalan yang sesuai. 🎯`,
    ja: `🌐 **言語と学年の設定:**\n\n- **言語の切り替え:** 右上の言語メニューから15言語からいつでも切り替えられます。\n- **学年の選択:** 上部バーで **1年生〜8年生** を選ぶと、自動で難易度が最適化されます！🎯`
  };
  return dict[lang] || `🌐 **Language & Grade Settings:**\n\n- **Languages:** Click the Language dropdown at the top right header to switch between 15 languages.\n- **Grades:** Select any grade from **1st Standard to 8th Standard** on the top grade bar to auto-adjust quiz difficulty!`;
}

function getLocalizedGeneralHelp(lang: string): string {
  const dict: Record<string, string> = {
    ta: `🤖 **EduBot AI வழிகாட்டி - EduMatrix Master**\n\nஉங்களுக்கு உதவ நான் தயாராக உள்ளேன்! நீங்கள் கேட்கக்கூடிய சில முக்கிய வழிகாட்டல்கள்:\n- 🧮 **கணித கேள்விகள்:** எந்த கணக்கையும் தட்டச்சு செய்யுங்கள் (உதா: "25 x 4", "100 / 5").\n- 📄 **பயிற்சி தாள் அச்சிடுதல்:** "பயிற்சி தாள் அச்சிடுவது எப்படி" என்று கேட்கவும்.\n- 📲 **வாட்ஸ்அப் பகிர்வு:** "வாட்ஸ்அப்பில் பகிர்வது எப்படி" என்று கேட்கவும்.\n- 📊 **மதிப்பெண் விவரங்கள்:** "மதிப்பெண்களை பார்ப்பது எப்படி" என்று கேட்கவும்.\n\nமேலும் என்ன உதவி தேவை? தட்டச்சு செய்யுங்கள்! 🌟`,
    hi: `🤖 **EduBot AI सहायक - EduMatrix Master**\n\nमैं आपकी सहायता के लिए तैयार हूँ! आप मुझसे ये प्रश्न पूछ सकते हैं:\n- 🧮 **गणित प्रश्न:** कोई भी सवाल पूछें (जैसे "25 x 4" या "100 / 5")।\n- 📄 **वर्कशीट प्रिंट:** "वर्कशीट कैसे प्रिंट करें" पूछें।\n- 📲 **व्हाट्सएप शेयर:** "व्हाट्सएप पर कैसे शेयर करें" पूछें।\n- 📊 **स्कोर व रिपोर्ट:** "स्कोर कैसे देखें" पूछें।\n\nआप और क्या जानना चाहते हैं? 🌟`,
    ml: `🤖 **EduBot AI സഹായി - EduMatrix Master**\n\nഞാൻ സഹായിക്കാൻ തയ്യാറാണ്! ചോദിക്കാവുന്ന ചില കാര്യങ്ങൾ:\n- 🧮 **കണക്ക് ചോദ്യങ്ങൾ:** ഏത് കണക്കും ടൈപ്പ് ചെയ്യാം (ഉദാ: "25 x 4").\n- 📄 **വർക്ക്‌ഷീറ്റ്:** "വർക്ക്‌ഷീറ്റ് എങ്ങനെ പ്രിന്റ് ചെയ്യാം" എന്ന് ചോദിക്കാം.\n- 📲 **വാട്ട്‌സ്ആപ്പ് ഷെയർ:** "വാട്ട്‌സ്ആപ്പിൽ എങ്ങനെ പങ്കിടാം" എന്ന് ചോദിക്കാം.\n- 📊 **സ്കോർ:** "റിപ്പോർട്ട് എങ്ങനെ കാണാം" എന്ന് ചോദിക്കാം. 🌟`,
    te: `🤖 **EduBot AI సహాయకుడు - EduMatrix Master**\n\nనేను మీకు సహాయం చేయడానికి సిద్ధంగా ఉన్నాను! మీరు అడగగల విషయాలు:\n- 🧮 **గణిత ప్రశ్నలు:** ఏ లెక్కనైనా అడగండి (ఉదా: "25 x 4").\n- 📄 **వర్క్‌షీట్ ప్రింట్:** "వర్క్‌షీట్ ఎలా ప్రింట్ చేయాలి" అని అడగండి.\n- 📲 **వాట్సాప్ షేర్:** "వాట్సాప్‌లో ఎలా షేర్ చేయాలి" అని అడగండి.\n- 📊 **స్కోర్లు:** "స్కోర్లు ఎలా చూడాలి" అని అడగండి. 🌟`,
    kn: `🤖 **EduBot AI ಸಹಾಯಕ - EduMatrix Master**\n\nನಿಮಗೆ ಸಹಾಯ ಮಾಡಲು ನಾನು ಸಿದ್ಧನಿದ್ದೇನೆ! ನೀವು ಕೇಳಬಹುದಾದ ಪ್ರಶ್ನೆಗಳು:\n- 🧮 **ಗಣಿತ ಲೆಕ್ಕಗಳು:** ಯಾವುದೇ ಲೆಕ್ಕ ಕೇಳಿ (ಉದಾ: "25 x 4").\n- 📄 **ವರ್ಕ್‌ಶೀಟ್:** "ವರ್ಕ್‌ಶೀಟ್ ಪ್ರಿಂಟ್ ಮಾಡುವುದು ಹೇಗೆ" ಎಂದು ಕೇಳಿ.\n- 📲 **ವಾಟ್ಸಾಪ್:** "ವಾಟ್ಸಾಪ್‌ನಲ್ಲಿ ಹಂಚಿಕೊಳ್ಳುವುದು ಹೇಗೆ" ಎಂದು ಕೇಳಿ.\n- 📊 **ಅಂಕಗಳು:** "ಅಂಕಗಳನ್ನು ನೋಡುವುದು ಹೇಗೆ" ಎಂದು ಕೇಳಿ. 🌟`,
    zh: `🤖 **EduBot 智能助手 - EduMatrix Master**\n\n我已经准备好为您解答！您可以向我咨询：\n- 🧮 **算术解答：** 输入任何数学计算题（例如 "25 x 4" 或 "144 / 12"）。\n- 📄 **打印工作表：** 询问“如何打印练习题”。\n- 📲 **分享测验：** 询问“如何通过 WhatsApp 分享”。\n- 📊 **查看成绩：** 询问“如何查看报告单”。\n\n请随时输入您的问题！🌟`,
    es: `🤖 **EduBot Asistente IA - EduMatrix Master**\n\n¡Estoy listo para ayudarte! Puedes preguntarme:\n- 🧮 **Resolver Problemas:** Escribe cualquier cálculo (ej: "25 x 4").\n- 📄 **Hojas de Trabajo:** Pregunta "cómo imprimir hojas de trabajo".\n- 📲 **Compartir en WhatsApp:** Pregunta "cómo compartir por WhatsApp".\n- 📊 **Puntuaciones:** Pregunta "cómo ver mis notas".\n\n¿Qué te gustaría hacer? 🌟`,
    fr: `🤖 **EduBot Assistant IA - EduMatrix Master**\n\nJe suis à votre disposition ! Vous pouvez me demander :\n- 🧮 **Calculs de maths :** Tapez n'importe quelle opération (ex : "25 x 4").\n- 📄 **Fiches d'exercices :** Demandez "comment imprimer des fiches".\n- 📲 **Partage WhatsApp :** Demandez "comment partager sur WhatsApp".\n- 📊 **Scores et progrès :** Demandez "comment voir mes résultats".\n\nQue souhaitez-vous savoir ? 🌟`,
    ar: `🤖 **EduBot المساعد الذكي - EduMatrix Master**\n\nأنا هنا لمساعدتك! يمكنك أن تسألني عن:\n- 🧮 **حل الرياضيات:** اكتب أي مسألة حسابية (مثال: "25 × 4").\n- 📄 **طباعة أوراق العمل:** اسأل "كيف أطبع أوراق العمل".\n- 📲 **مشاركة واتساب:** اسأل "كيف أشارك عبر واتساب".\n- 📊 **الدرجات:** اسأل "كيف أرى شهادتي".\n\nكيف يمكنني مساعدتك الآن؟ 🌟`,
    ru: `🤖 **EduBot AI-помощник - EduMatrix Master**\n\nЯ готов вам помочь! Вы можете спросить меня:\n- 🧮 **Математика:** Напишите любой пример (например, "25 x 4").\n- 📄 **Печать заданий:** Спросите "как распечатать рабочий лист".\n- 📲 **WhatsApp:** Спросите "как отправить тест в WhatsApp".\n- 📊 **Оценки:** Спросите "как посмотреть отчет".\n\nЧем еще могу помочь? 🌟`,
    nl: `🤖 **EduBot AI-assistent - EduMatrix Master**\n\nIk sta voor je klaar! Je kunt me vragen stellen over:\n- 🧮 **Wiskundige berekeningen:** Typ elke som (bijv. "25 x 4").\n- 📄 **Werkbladen:** Vraag "hoe werkbladen afdrukken".\n- 📲 **WhatsApp:** Vraag "hoe delen via WhatsApp".\n- 📊 **Scores:** Vraag "hoe rapport bekijken".\n\nWat wil je weten? 🌟`,
    pt: `🤖 **EduBot Assistente de IA - EduMatrix Master**\n\nEstou pronto para ajudar! Você pode me perguntar:\n- 🧮 **Cálculos Matemáticos:** Digite qualquer conta (ex: "25 x 4").\n- 📄 **Folhas de Atividades:** Pergunte "como imprimir folhas de exercícios".\n- 📲 **WhatsApp:** Pergunte "como compartilhar no WhatsApp".\n- 📊 **Boletim:** Pergunte "como ver meu relatório".\n\nComo posso te ajudar agora? 🌟`,
    ms: `🤖 **Pembantu AI EduBot - EduMatrix Master**\n\nSaya bersedia membantu anda! Anda boleh tanya tentang:\n- 🧮 **Pengiraan Matematik:** Taip sebarang soalan (cth: "25 x 4").\n- 📄 **Lembaran Kerja:** Tanya "cara cetak lembaran kerja".\n- 📲 **WhatsApp:** Tanya "cara kongsi di WhatsApp".\n- 📊 **Skor & Laporan:** Tanya "cara semak laporan".\n\nAda apa-apa lagi yang boleh saya bantu? 🌟`,
    ja: `🤖 **EduBot AIアシスタント - EduMatrix Master**\n\nどのようなことでもお答えします！以下のような質問をお試しください:\n- 🧮 **算数の計算問題:** どんな計算でも入力してください（例: 「25 × 4」）。\n- 📄 **ワークシート印刷:** 「ワークシートの印刷方法は？」\n- 📲 **WhatsApp共有:** 「WhatsAppでの共有方法は？」\n- 📊 **成績・レポート:** 「成績の確認方法は？」\n\n知りたいことを入力してください！🌟`
  };
  return dict[lang] || `🤖 **EduBot AI Assistant - EduMatrix Master**\n\nI'm here to help you master math and make full use of EduMatrix Master!\n\nHere are popular things you can do:\n- 🧮 **Solve Math:** Ask me any math calculation or problem (e.g. "what is 15 × 12").\n- 📄 **Print Worksheets:** Ask "how to print worksheets".\n- 📲 **Share via WhatsApp:** Ask "how to share on WhatsApp".\n- 🎯 **Practice Quizzes:** Select an operation (Addition, Subtraction, Multiplication, Division) and test your speed!\n\nHow else can I help you today?`;
}

// Start Express server with Vite middleware in development or static serving in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`EduMatrix Master Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();


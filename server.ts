import express from 'express';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '5mb' }));

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

// AI Chatbot Helper API Route for Students, Teachers, and Parents
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, userRole, userLanguage, userStandard } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    const lastUserMessage = [...messages].reverse().find((m: { role: string; content: string }) => m.role === 'user')?.content || '';

    const ai = getGeminiClient();
    if (!ai) {
      const fallbackReply = generateSmartFallbackReply(lastUserMessage, userRole, userLanguage, userStandard);
      return res.json({ reply: fallbackReply });
    }

    const systemInstruction = `You are EduBot, an empathetic, intelligent, and cheerful AI Assistant built into EduMatrix Master (Math Master).
EduMatrix Master is an interactive elementary and middle school mathematics app designed for Students (Grades 1st to 8th Standard), Teachers, and Parents.

Key Features & Capabilities of EduMatrix Master:
1. Practice Quizzes: Generates dynamic math quizzes covering Addition, Subtraction, Multiplication, Division, Word Problems, Fractions, Decimals, Algebra, Geometry, and Math Tricks.
2. Custom Quiz Generator: Allows teachers and parents to customize number of questions (10 to 100), timer duration, difficulty (Easy, Medium, Hard, Challenge), and operational types.
3. Printable Worksheets & Answer Keys: Generates clean, printer-friendly PDF worksheets for classroom assignments or offline home practice with detachable answer keys.
4. WhatsApp Sharing: Teachers can instantly share active quiz links or worksheet codes directly with students or parents via WhatsApp.
5. Voice Tutor & Speech: Includes interactive audio explanations and voice assistance for primary students.
6. Multi-language Support: Supports English, Tamil, Malayalam, Telugu, Kannada, Hindi, Chinese, Spanish, French, Arabic, Russian, Dutch, Portuguese, Malay, Japanese.
7. Role Perspectives:
   - Student Mode: Focuses on gamified learning, high score badges, audio guidance, and progress stars.
   - Teacher Mode: Focuses on school branding, class roster performance, worksheet printing, and automated grading.
   - Parent Mode: Focuses on tracking child's standard, home revision, parent-teacher signatures, and report cards.

Contextual User Information:
- Current Role: ${userRole || 'General User'}
- Grade/Standard: ${userStandard || 'Not specified'}
- Preferred Language: ${userLanguage || 'English'}

Your Guidance Rules:
1. Be concise, encouraging, and highly helpful.
2. If the user asks in Tamil, Hindi, Malayalam, Spanish, French, or another language, respond in that same language!
3. If a student asks a math problem or concept question, explain it step-by-step in simple, easy-to-understand terms suitable for their grade level.
4. If a teacher or parent asks how to use features (like printing worksheets, sharing on WhatsApp, or changing school branding), provide clear, numbered step-by-step instructions.
5. Keep answers well-formatted with markdown, bullet points, and friendly emojis where appropriate.`;

    // Convert message history to format required by Gemini generateContent
    const formattedHistory = messages.map((m: { role: string; content: string }) => {
      const role = m.role === 'user' ? 'user' : 'model';
      return `${role === 'user' ? 'User' : 'Assistant'}: ${m.content}`;
    }).join('\n\n');

    const prompt = `System Context:\n${systemInstruction}\n\nConversation History:\n${formattedHistory}\n\nAssistant:`;

    // Try primary gemini-2.5-flash model, with fallback models
    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
    let reply = '';

    for (const modelName of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
        });
        if (response.text) {
          reply = response.text;
          break;
        }
      } catch (err) {
        console.warn(`Model ${modelName} failed, trying next fallback...`, err);
      }
    }

    if (!reply) {
      reply = generateSmartFallbackReply(lastUserMessage, userRole, userLanguage, userStandard);
    }

    return res.json({ reply });
  } catch (err: unknown) {
    console.error('Error in /api/chat:', err);
    const lastUserMsg = req.body?.messages ? [...req.body.messages].reverse().find((m: { role: string; content: string }) => m.role === 'user')?.content || '' : '';
    const fallback = generateSmartFallbackReply(lastUserMsg, req.body?.userRole, req.body?.userLanguage, req.body?.userStandard);
    return res.json({ reply: fallback });
  }
});

function generateSmartFallbackReply(userText: string, userRole?: string, userLang?: string, userStandard?: string): string {
  const query = (userText || '').toLowerCase().trim();
  const role = userRole || 'student';

  // Math calculation evaluator if user asks a simple math question e.g. "what is 5 x 5" or "12 + 15"
  const mathMatch = query.match(/(\d+)\s*([\+\-\*\/x×÷])\s*(\d+)/);
  if (mathMatch) {
    const num1 = parseFloat(mathMatch[1]);
    const op = mathMatch[2];
    const num2 = parseFloat(mathMatch[3]);
    let result = 0;
    let opSymbol = op;
    if (op === '+' ) result = num1 + num2;
    else if (op === '-') result = num1 - num2;
    else if (op === '*' || op === 'x' || op === '×') { result = num1 * num2; opSymbol = '×'; }
    else if (op === '/' || op === '÷') { result = num2 !== 0 ? num1 / num2 : NaN; opSymbol = '÷'; }

    if (!isNaN(result)) {
      return `🔢 **Math Solution:**\n\n${num1} ${opSymbol} ${num2} = **${result}**\n\nKeep up the great practice! You can also solve full dynamic quizzes in EduMatrix Master by choosing Addition, Subtraction, Multiplication, or Division on the top bar! 🌟`;
    }
  }

  // Greeting check
  if (query.includes('hi') || query.includes('hello') || query.includes('hey') || query.includes('வணக்கம்') || query.includes('नमस्ते') || query.includes('வணகம்')) {
    if (role === 'teacher') {
      return `👋 **Welcome, Educator!** I am **EduBot**, your AI Assistant for EduMatrix Master.\n\nI can help you with:\n- 📝 Creating & printing customized worksheets with answer keys\n- 📲 Sharing quiz assignments directly with students/parents via WhatsApp\n- 🏫 Customizing school branding and class grade parameters\n\nHow can I support your classroom today?`;
    } else if (role === 'parent') {
      return `👋 **Hello Parent!** I am **EduBot**, your math revision assistant.\n\nI can assist you with:\n- 📊 Tracking your child's math scores & progress\n- 📄 Generating offline practice worksheets for home revision\n- ✍️ Parent-Teacher signature reports\n\nWhat would you like to explore today?`;
    } else {
      return `👋 **Hello Math Master!** I am **EduBot**, your AI Math Assistant.\n\nI'm here to help you solve math problems, practice times tables, and earn high score stars! ⭐\n\nAsk me any math question or ask how to use EduMatrix Master! 🚀`;
    }
  }

  // Worksheet / Print query
  if (query.includes('worksheet') || query.includes('print') || query.includes('pdf') || query.includes('paper') || query.includes('download')) {
    return `📄 **How to Print & Download Worksheets in EduMatrix Master:**\n\n1. Select your target **Grade/Standard** and **Operation** (e.g. Multiplication, Addition).\n2. Click on the **Worksheet View** tab or press **"Generate Printable Worksheet"**.\n3. Customize the number of questions, school header, and answer key settings.\n4. Click **"Print / Save as PDF"** to print or export directly to your device!\n\nNeed extra help? Ask me any question! 💡`;
  }

  // WhatsApp / Share query
  if (query.includes('whatsapp') || query.includes('share') || query.includes('send') || query.includes('code')) {
    return `📲 **How to Share Quizzes on WhatsApp:**\n\n1. In **Teacher** or **Parent** mode, click the green **"Share Quiz"** button on the worksheet/quiz section.\n2. A custom WhatsApp message containing the quiz details and standard assignment code will automatically open.\n3. Choose your class group or parent contact on WhatsApp and press Send!\n4. Students can click the link or enter the code to take the exact assignment online. 🎯`;
  }

  // Score / Progress query
  if (query.includes('score') || query.includes('progress') || query.includes('badge') || query.includes('report') || query.includes('star')) {
    return `📊 **Checking Scores & Progress Reports:**\n\n- After finishing a quiz session, click **"Check My Score!"** to see your immediate percentage score, time spent, and performance breakdown.\n- Click **"View Full Report Card"** to generate a printable performance certificate.\n- Teachers and parents can review total accuracy badges and star rewards! 🌟`;
  }

  // Language / Grade query
  if (query.includes('language') || query.includes('tamil') || query.includes('hindi') || query.includes('grade') || query.includes('standard')) {
    return `🌐 **Language & Grade Settings:**\n\n- **Languages:** Click the Language dropdown at the top right header to switch between 15 languages (English, Tamil, Hindi, Malayalam, Telugu, Kannada, Spanish, French, etc.).\n- **Grades:** Select any grade from **1st Standard to 8th Standard** on the top grade selector bar to automatically scale quiz difficulty!`;
  }

  // Default fallback response
  return `🤖 **EduBot AI Assistant - EduMatrix Master**\n\nI'm here to help you master math and make full use of EduMatrix Master!\n\nHere are popular things you can do:\n- 🧮 **Solve Math:** Ask me any math calculation or problem (e.g. "what is 15 × 12").\n- 📄 **Print Worksheets:** Ask "how to print worksheets".\n- 📲 **Share via WhatsApp:** Ask "how to share on WhatsApp".\n- 🎯 **Practice Quizzes:** Select an operation (Addition, Subtraction, Multiplication, Division) and test your speed!\n\nHow else can I help you today?`;
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`EduMatrix Master Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

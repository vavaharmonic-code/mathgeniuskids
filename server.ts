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

    const ai = getGeminiClient();
    if (!ai) {
      return res.json({
        reply: "Hello! I am EduBot, your AI Assistant for EduMatrix Master. (Note: GEMINI_API_KEY environment variable is missing. Please configure it in your secrets to enable live AI responses). How can I help you today with math practice or worksheets?",
      });
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

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
    });

    const reply = response.text || "I'm here to help with EduMatrix Master! Could you please ask your question again?";

    return res.json({ reply });
  } catch (err: unknown) {
    console.error('Error in /api/chat:', err);
    const errorMessage = err instanceof Error ? err.message : 'Failed to generate AI response';
    return res.status(500).json({ error: errorMessage });
  }
});

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

import OpenAI from "openai";
import { getKnowledge, getChatHistory, saveChatMessage, searchKnowledge } from "./database.js";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// For embeddings, we'll use OpenAI if available, or a fallback if needed
const embeddingClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.OPENAI_API_KEY ? "https://api.openai.com/v1" : "https://api.deepseek.com",
});

export async function getEmbedding(text: string): Promise<number[]> {
  try {
    const response = await embeddingClient.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return response.data[0].embedding;
  } catch (err) {
    console.error("getEmbedding error:", err);
    // Fallback to a zero vector if embedding fails (not ideal, but prevents crash)
    return new Array(1536).fill(0);
  }
}

export async function analyzeAndNameKnowledge(
  content: string
): Promise<{ label: string; summary: string; category: string; metadata: any }> {
  if (!process.env.DEEPSEEK_API_KEY) {
    return { 
      label: "knowledge_" + Date.now(), 
      summary: content.substring(0, 100),
      category: "general",
      metadata: {}
    };
  }

  try {
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: `أنت محلل استراتيجيات برمجية متخصص. 
مهمتك: تحليل النص المُدخَل وتصنيفه كـ "مصدر حقيقة" لوكلاء الذكاء الاصطناعي.
أجب بـ JSON يحتوي على:
1. label: اسم فريد (snake_case) بالإنجليزية.
2. summary: ملخص بالعربية (بحد أقصى 150 حرف).
3. category: الفئة (architectural_pattern, coding_standard, approved_library, project_constraint, general).
4. metadata: كائن JSON يحتوي على (language, importance: high/medium/low, tags).

أجب فقط بـ JSON صحيح.`,
        },
        {
          role: "user",
          content: content,
        },
      ],
      temperature: 0.3,
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      label: (parsed.label ?? "knowledge_item").toLowerCase().replace(/\s+/g, "_"),
      summary: parsed.summary ?? content.substring(0, 150),
      category: parsed.category ?? "general",
      metadata: parsed.metadata ?? {},
    };
  } catch (err) {
    console.error("analyzeAndNameKnowledge error:", err);
    return { 
      label: "knowledge_" + Date.now(), 
      summary: content.substring(0, 150),
      category: "general",
      metadata: {}
    };
  }
}

export async function getAiResponse(
  projectId: number,
  userMessage: string,
  telegramUserId?: number
): Promise<string> {
  if (!process.env.DEEPSEEK_API_KEY) {
    return "❌ خطأ: DEEPSEEK_API_KEY غير مضبوط.";
  }

  // Use semantic search to find relevant context
  const queryEmbedding = await getEmbedding(userMessage);
  const relevantKnowledge = await searchKnowledge(projectId, queryEmbedding, 5);
  
  let knowledgeContext = "";
  if (relevantKnowledge.length > 0) {
    knowledgeContext = "إليك السياق ذو الصلة من قاعدة المعرفة (مصدر الحقيقة):\n";
    relevantKnowledge.forEach((k, i) => {
      knowledgeContext += `${i + 1}. [${k.category}] ${k.label}: ${k.content}\n`;
    });
  } else {
    // Fallback to general knowledge if no semantic matches
    const allKnowledge = await getKnowledge(projectId);
    if (allKnowledge.length > 0) {
      knowledgeContext = "إليك القواعد العامة للمشروع:\n";
      allKnowledge.slice(0, 10).forEach((k, i) => {
        knowledgeContext += `${i + 1}. ${k.content}\n`;
      });
    }
  }

  const history = await getChatHistory(projectId, telegramUserId, 10);

  const systemPrompt = `أنت خبير برمجي ومساعد ذكي متخصص. مهمتك مساعدة المستخدم في مشروعه البرمجي.
لقد تم تزويدك بقاعدة معرفة تعمل كـ "مصدر حقيقة" (Source of Truth).
يجب عليك الالتزام التام بالتعليمات والأنماط المعمارية والمعايير المذكورة.
هدفنا هو منع الهلوسة وضمان جودة الكود.

--- سياق المشروع (مصدر الحقيقة) ---
${knowledgeContext}
--------------------------`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((h: any) => ({ role: h.role as "user" | "assistant", content: h.content })),
    { role: "user", content: userMessage },
  ];

  try {
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages,
      temperature: 0.7,
    });
    const reply = response.choices[0]?.message?.content ?? "لا يوجد رد";
    await saveChatMessage(projectId, "user", userMessage, telegramUserId);
    await saveChatMessage(projectId, "assistant", reply, telegramUserId);
    return reply;
  } catch (error) {
    console.error("DeepSeek error:", error);
    return `عذراً، حدث خطأ: ${String(error)}`;
  }
}

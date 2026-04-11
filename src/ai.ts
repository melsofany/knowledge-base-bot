import OpenAI from "openai";
import { getKnowledge, getChatHistory, saveChatMessage } from "./database.js";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

export async function analyzeAndNameKnowledge(
  content: string
): Promise<{ label: string; summary: string }> {
  if (!process.env.DEEPSEEK_API_KEY) {
    return { label: "بدون_اسم", summary: content.substring(0, 100) };
  }

  try {
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: `أنت محلل استراتيجيات برمجية متخصص. 
مهمتك: تحليل النص المُدخَل وإعطائه:
1. label: اسم قصير فريد باللغة الإنجليزية بدون مسافات (snake_case) يصف نوع الاستراتيجية أو التعليمة بدقة. مثال: mev_arbitrage_strategy أو blockchain_config أو api_rate_limit
2. summary: ملخص قصير باللغة العربية لا يتجاوز 150 حرف يشرح ما تعنيه هذه التعليمة

أجب فقط بـ JSON صحيح بهذا الشكل:
{"label": "...", "summary": "..."}

لا تضف أي نص آخر خارج الـ JSON.`,
        },
        {
          role: "user",
          content: content,
        },
      ],
      stream: false,
      temperature: 0.3,
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { label?: string; summary?: string };

    const label = (parsed.label ?? "knowledge_item")
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, "")
      .toLowerCase()
      .substring(0, 60);

    const summary = (parsed.summary ?? content.substring(0, 150)).substring(0, 200);

    return { label, summary };
  } catch (err) {
    console.error("analyzeAndNameKnowledge error:", err);
    const fallbackLabel = "knowledge_" + Date.now();
    return { label: fallbackLabel, summary: content.substring(0, 150) };
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

  const knowledge = await getKnowledge(projectId);

  let knowledgeContext: string;
  if (knowledge.length > 0) {
    knowledgeContext = "إليك القواعد والتعليمات الصارمة لهذا المشروع:\n";
    knowledge.forEach((k, i) => {
      const labelPart = k.label ? `[${k.label}] ` : "";
      knowledgeContext += `${i + 1}. ${labelPart}${k.content}\n`;
    });
  } else {
    knowledgeContext = "لا توجد تعليمات خاصة مخزنة لهذا المشروع بعد.";
  }

  const history = await getChatHistory(projectId, telegramUserId, 10);

  const systemPrompt = `أنت خبير برمجي ومساعد ذكي متخصص. مهمتك مساعدة المستخدم في مشروعه البرمجي.
لقد تم تزويدك بقاعدة معرفة خاصة بهذا المشروع تحديداً.
يجب عليك الالتزام التام بالتعليمات الموجودة في قاعدة المعرفة.
إذا تعارضت تعليمات المستخدم مع قاعدة المعرفة، نبهه لذلك ولكن اتبع قاعدة المعرفة إلا إذا طلب تغييرها.

--- قاعدة معرفة المشروع ---
${knowledgeContext}
--------------------------`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
    { role: "user", content: userMessage },
  ];

  try {
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages,
      stream: false,
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

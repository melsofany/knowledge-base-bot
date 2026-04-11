import OpenAI from "openai";
import { getKnowledge, getChatHistory, saveChatMessage } from "./database.js";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

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
      knowledgeContext += `${i + 1}. ${k.content}\n`;
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

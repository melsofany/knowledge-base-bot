import { Telegraf, Markup } from "telegraf";
import {
  createProject,
  getProjects,
  getProjectById,
  addKnowledge,
  getKnowledge,
  getUserSession,
  setUserSession,
} from "./database.js";
import { getAiResponse } from "./ai.js";

type BotState = { action?: "new_project" | "add_knowledge" };
const userStates = new Map<number, BotState>();

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📁 مشاريعي", "list_projects")],
    [Markup.button.callback("➕ إنشاء مشروع جديد", "new_project")],
    [Markup.button.callback("💡 إضافة تعليمات للمشروع الحالي", "add_knowledge")],
    [Markup.button.callback("📋 عرض تعليمات المشروع الحالي", "list_knowledge")],
    [Markup.button.callback("🔑 API Token للمشروع الحالي", "get_token")],
  ]);
}

export function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN not set — bot disabled");
    return null;
  }

  const bot = new Telegraf(token);

  bot.command("start", async (ctx) => {
    const name = ctx.from?.first_name ?? "صديقي";
    await ctx.reply(
      `مرحباً بك يا ${name} في نظام إدارة المعرفة البرمجية الذكي! 🚀\n\n` +
      "هذا النظام يحفظ تعليمات كل مشروع بشكل منفصل حتى لا ينسى الـ AI أي شيء.\n" +
      "كل مشروع له API Token خاص يمكنك استخدامه مع أي AI Agent.\n\n" +
      "اختر ما تريد:",
      mainKeyboard()
    );
  });

  bot.command("menu", async (ctx) => {
    await ctx.reply("القائمة الرئيسية:", mainKeyboard());
  });

  bot.on("callback_query", async (ctx) => {
    const query = ctx.callbackQuery;
    if (!("data" in query)) return;
    const data = query.data;
    const userId = ctx.from?.id;
    if (!userId) return;
    await ctx.answerCbQuery();

    if (data === "list_projects") {
      const projects = await getProjects();
      if (!projects.length) {
        await ctx.editMessageText("لا توجد مشاريع بعد. ابدأ بإنشاء مشروعك الأول!",
          Markup.inlineKeyboard([
            [Markup.button.callback("➕ إنشاء مشروع", "new_project")],
            [Markup.button.callback("🔙 رجوع", "back_main")],
          ])
        );
        return;
      }
      const buttons = projects.map((p) => [Markup.button.callback(`📌 ${p.name}`, `select_${p.id}`)]);
      buttons.push([Markup.button.callback("🔙 رجوع", "back_main")]);
      await ctx.editMessageText("اختر المشروع:", Markup.inlineKeyboard(buttons));
      return;
    }

    if (data.startsWith("select_")) {
      const projectId = parseInt(data.replace("select_", ""));
      await setUserSession(userId, projectId);
      const project = await getProjectById(projectId);
      userStates.delete(userId);
      await ctx.editMessageText(
        `✅ تم اختيار المشروع: *${project?.name}*\n\n` +
        "• أرسل أي سؤال برمجي للمحادثة مع الـ AI\n" +
        "• أضف تعليمات لهذا المشروع من القائمة\n" +
        "• احصل على API Token لأي AI Agent",
        { parse_mode: "Markdown", ...mainKeyboard() }
      );
      return;
    }

    if (data === "new_project") {
      userStates.set(userId, { action: "new_project" });
      await ctx.editMessageText("📝 أرسل *اسم المشروع الجديد* الآن:\n(مثلاً: Blockchain App أو ERP System)",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (data === "add_knowledge") {
      const session = await getUserSession(userId);
      if (!session?.active_project_id) {
        await ctx.editMessageText("⚠️ لم تختر مشروعاً بعد.",
          Markup.inlineKeyboard([[Markup.button.callback("📁 اختر مشروع", "list_projects")]])
        );
        return;
      }
      userStates.set(userId, { action: "add_knowledge" });
      const project = await getProjectById(session.active_project_id);
      await ctx.editMessageText(
        `💡 أرسل التعليمات لمشروع *${project?.name}*:\n\n` +
        "مثال: استخدم TypeScript فقط\n" +
        "مثال: قاعدة البيانات PostgreSQL مع Drizzle ORM\n" +
        "مثال: الـ API يعمل على منفذ 3000",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (data === "list_knowledge") {
      const session = await getUserSession(userId);
      if (!session?.active_project_id) { await ctx.reply("⚠️ لم تختر مشروعاً."); return; }
      const project = await getProjectById(session.active_project_id);
      const knowledge = await getKnowledge(session.active_project_id);
      if (!knowledge.length) {
        await ctx.editMessageText(`📋 لا توجد تعليمات لمشروع *${project?.name}* بعد.`,
          { parse_mode: "Markdown", ...mainKeyboard() }
        );
        return;
      }
      let text = `📋 تعليمات مشروع *${project?.name}*:\n\n`;
      knowledge.forEach((k, i) => { text += `${i + 1}. ${k.content}\n\n`; });
      await ctx.editMessageText(text, { parse_mode: "Markdown", ...mainKeyboard() });
      return;
    }

    if (data === "get_token") {
      const session = await getUserSession(userId);
      if (!session?.active_project_id) { await ctx.reply("⚠️ لم تختر مشروعاً."); return; }
      const project = await getProjectById(session.active_project_id);
      if (!project) return;
      const base = process.env.API_BASE_URL ?? "https://your-app.onrender.com";
      await ctx.editMessageText(
        `🔑 *API Token لمشروع ${project.name}*\n\n` +
        `Token:\n\`${project.api_token}\`\n\n` +
        `📡 *نقاط الـ API:*\n\n` +
        `• معلومات: \`GET ${base}/api/project/info\`\n` +
        `• المعرفة: \`GET ${base}/api/project/knowledge\`\n` +
        `• محادثة: \`POST ${base}/api/project/chat\`\n` +
        `• التاريخ: \`GET ${base}/api/project/history\`\n\n` +
        `*Header مطلوب:*\n\`Authorization: Bearer ${project.api_token}\``,
        { parse_mode: "Markdown", ...mainKeyboard() }
      );
      return;
    }

    if (data === "back_main") {
      await ctx.editMessageText("القائمة الرئيسية:", mainKeyboard());
    }
  });

  bot.on("message", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !("text" in ctx.message)) return;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const state = userStates.get(userId);

    if (state?.action === "new_project") {
      const name = text.trim();
      if (!name) { await ctx.reply("❌ الاسم لا يمكن أن يكون فارغاً."); return; }
      try {
        const project = await createProject(name);
        await setUserSession(userId, project.id);
        userStates.delete(userId);
        await ctx.reply(
          `✅ تم إنشاء مشروع *${project.name}*!\n\n🔑 API Token:\n\`${project.api_token}\`\n\nأضف تعليمات أو ابدأ المحادثة:`,
          { parse_mode: "Markdown", ...mainKeyboard() }
        );
      } catch {
        userStates.delete(userId);
        await ctx.reply("❌ اسم المشروع موجود بالفعل. اختر اسماً آخر.", mainKeyboard());
      }
      return;
    }

    if (state?.action === "add_knowledge") {
      const session = await getUserSession(userId);
      if (!session?.active_project_id) { userStates.delete(userId); await ctx.reply("⚠️ انتهت الجلسة.", mainKeyboard()); return; }
      await addKnowledge(session.active_project_id, text.trim());
      userStates.delete(userId);
      const project = await getProjectById(session.active_project_id);
      await ctx.reply(
        `✅ تم حفظ التعليمات لمشروع *${project?.name}*!`,
        { parse_mode: "Markdown", ...mainKeyboard() }
      );
      return;
    }

    const session = await getUserSession(userId);
    if (!session?.active_project_id) {
      await ctx.reply("⚠️ لم تختر مشروعاً بعد:", mainKeyboard());
      return;
    }

    const project = await getProjectById(session.active_project_id);
    const typing = await ctx.reply(`⏳ جاري التحليل للمشروع *${project?.name}*...`, { parse_mode: "Markdown" });

    try {
      const reply = await getAiResponse(session.active_project_id, text, userId);
      await ctx.telegram.deleteMessage(ctx.chat.id, typing.message_id).catch(() => {});
      await ctx.reply(reply, mainKeyboard());
    } catch (err) {
      console.error("Bot AI error:", err);
      await ctx.telegram.deleteMessage(ctx.chat.id, typing.message_id).catch(() => {});
      await ctx.reply("❌ حدث خطأ. حاول مرة أخرى.");
    }
  });

  return bot;
}

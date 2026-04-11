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

async function safeEdit(ctx: any, text: string, extra?: any) {
  try {
    await ctx.editMessageText(text, extra);
  } catch {
    // If edit fails (old message, etc.), send a new message
    await ctx.reply(text, extra);
  }
}

export function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN not set — bot disabled");
    return null;
  }

  const bot = new Telegraf(token);

  // Global error handler
  bot.catch((err: unknown, ctx: any) => {
    console.error("Bot unhandled error:", err);
    ctx.reply("❌ حدث خطأ غير متوقع. أرسل /start للبدء من جديد.").catch(() => {});
  });

  bot.command("start", async (ctx) => {
    const name = ctx.from?.first_name ?? "صديقي";
    userStates.delete(ctx.from!.id);
    await ctx.reply(
      `مرحباً بك يا ${name} في نظام إدارة المعرفة البرمجية الذكي! 🚀\n\n` +
      "هذا النظام يحفظ تعليمات كل مشروع بشكل منفصل حتى لا ينسى الـ AI أي شيء.\n" +
      "كل مشروع له API Token خاص يمكنك استخدامه مع أي AI Agent.\n\n" +
      "اختر ما تريد:",
      mainKeyboard()
    );
  });

  bot.command("menu", async (ctx) => {
    userStates.delete(ctx.from!.id);
    await ctx.reply("القائمة الرئيسية:", mainKeyboard());
  });

  bot.on("callback_query", async (ctx) => {
    const query = ctx.callbackQuery;
    if (!("data" in query)) return;
    const data = query.data;
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
      await ctx.answerCbQuery();
    } catch {
      // ignore
    }

    try {
      if (data === "list_projects") {
        const projects = await getProjects();
        if (!projects.length) {
          await safeEdit(ctx,
            "لا توجد مشاريع بعد. ابدأ بإنشاء مشروعك الأول!",
            Markup.inlineKeyboard([
              [Markup.button.callback("➕ إنشاء مشروع", "new_project")],
              [Markup.button.callback("🔙 رجوع", "back_main")],
            ])
          );
          return;
        }
        const buttons = projects.map((p) => [
          Markup.button.callback(`📌 ${p.name}`, `sel_${p.id}`)
        ]);
        buttons.push([Markup.button.callback("🔙 رجوع", "back_main")]);
        await safeEdit(ctx, "اختر المشروع:", Markup.inlineKeyboard(buttons));
        return;
      }

      if (data.startsWith("sel_")) {
        const projectId = parseInt(data.replace("sel_", ""));
        await setUserSession(userId, projectId);
        const project = await getProjectById(projectId);
        userStates.delete(userId);
        await safeEdit(ctx,
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
        await safeEdit(ctx,
          "📝 أرسل *اسم المشروع الجديد* الآن:\n(مثلاً: Blockchain App أو ERP System)",
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (data === "add_knowledge") {
        const session = await getUserSession(userId);
        if (!session?.active_project_id) {
          await safeEdit(ctx,
            "⚠️ لم تختر مشروعاً بعد. اختر مشروعاً أولاً:",
            Markup.inlineKeyboard([[Markup.button.callback("📁 اختر مشروع", "list_projects")]])
          );
          return;
        }
        userStates.set(userId, { action: "add_knowledge" });
        const project = await getProjectById(session.active_project_id);
        await safeEdit(ctx,
          `💡 أرسل التعليمات لمشروع *${project?.name}*:\n\n` +
          "مثال: استخدم TypeScript فقط\n" +
          "مثال: قاعدة البيانات PostgreSQL مع Drizzle ORM\n" +
          "مثال: API يعمل على منفذ 3000",
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (data === "list_knowledge") {
        const session = await getUserSession(userId);
        if (!session?.active_project_id) {
          await ctx.reply("⚠️ لم تختر مشروعاً بعد.", mainKeyboard());
          return;
        }
        const project = await getProjectById(session.active_project_id);
        const knowledge = await getKnowledge(session.active_project_id);
        if (!knowledge.length) {
          await safeEdit(ctx,
            `📋 لا توجد تعليمات لمشروع *${project?.name}* بعد.`,
            { parse_mode: "Markdown", ...mainKeyboard() }
          );
          return;
        }
        let text = `📋 تعليمات مشروع *${project?.name}*:\n\n`;
        knowledge.forEach((k, i) => { text += `${i + 1}. ${k.content}\n\n`; });
        await safeEdit(ctx, text, { parse_mode: "Markdown", ...mainKeyboard() });
        return;
      }

      if (data === "get_token") {
        const session = await getUserSession(userId);
        if (!session?.active_project_id) {
          await ctx.reply("⚠️ لم تختر مشروعاً بعد.", mainKeyboard());
          return;
        }
        const project = await getProjectById(session.active_project_id);
        if (!project) return;
        const base = process.env.API_BASE_URL ?? "https://knowledge-base-bot.onrender.com";
        await safeEdit(ctx,
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
        await safeEdit(ctx, "القائمة الرئيسية:", mainKeyboard());
      }

    } catch (err) {
      console.error("Callback error:", err);
      await ctx.reply("❌ حدث خطأ. جرب مرة أخرى أو أرسل /menu").catch(() => {});
    }
  });

  bot.on("message", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !("text" in ctx.message)) return;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const state = userStates.get(userId);

    try {
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
        } catch (err: any) {
          userStates.delete(userId);
          if (err?.code === "23505") {
            // Unique constraint violation
            await ctx.reply(
              `❌ اسم المشروع "*${name}*" موجود بالفعل.\n\nاختر المشروع من قائمة مشاريعي أو اختر اسماً مختلفاً:`,
              { parse_mode: "Markdown", ...mainKeyboard() }
            );
          } else {
            await ctx.reply("❌ حدث خطأ أثناء إنشاء المشروع. حاول مرة أخرى.", mainKeyboard());
            console.error("Create project error:", err);
          }
        }
        return;
      }

      if (state?.action === "add_knowledge") {
        const session = await getUserSession(userId);
        if (!session?.active_project_id) {
          userStates.delete(userId);
          await ctx.reply("⚠️ انتهت الجلسة. اختر مشروعاً:", mainKeyboard());
          return;
        }
        await addKnowledge(session.active_project_id, text.trim());
        userStates.delete(userId);
        const project = await getProjectById(session.active_project_id);
        await ctx.reply(
          `✅ تم حفظ التعليمات لمشروع *${project?.name}*!`,
          { parse_mode: "Markdown", ...mainKeyboard() }
        );
        return;
      }

      // Regular chat — use AI with project context
      const session = await getUserSession(userId);
      if (!session?.active_project_id) {
        await ctx.reply("⚠️ لم تختر مشروعاً بعد. اختر مشروعاً للبدء في المحادثة:", mainKeyboard());
        return;
      }

      const project = await getProjectById(session.active_project_id);
      const typing = await ctx.reply(
        `⏳ جاري التحليل للمشروع *${project?.name}*...`,
        { parse_mode: "Markdown" }
      );

      try {
        const reply = await getAiResponse(session.active_project_id, text, userId);
        await ctx.telegram.deleteMessage(ctx.chat.id, typing.message_id).catch(() => {});
        await ctx.reply(reply, mainKeyboard());
      } catch (err) {
        console.error("AI error:", err);
        await ctx.telegram.deleteMessage(ctx.chat.id, typing.message_id).catch(() => {});
        await ctx.reply("❌ حدث خطأ في الذكاء الاصطناعي. حاول مرة أخرى.");
      }

    } catch (err) {
      console.error("Message handler error:", err);
      await ctx.reply("❌ حدث خطأ. أرسل /start للبدء من جديد.").catch(() => {});
    }
  });

  return bot;
}

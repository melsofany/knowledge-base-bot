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
import { getAiResponse, analyzeAndNameKnowledge } from "./ai.js";

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function safeReply(ctx: any, text: string, extra?: any) {
  try {
    await ctx.reply(text, extra);
  } catch (err) {
    console.error("safeReply failed:", err);
  }
}

async function safeEdit(ctx: any, text: string, extra?: any) {
  try {
    await ctx.editMessageText(text, extra);
  } catch {
    await safeReply(ctx, text, extra);
  }
}

async function sendLongMessage(ctx: any, text: string, extra?: any) {
  const MAX_LENGTH = 4000;
  if (text.length <= MAX_LENGTH) {
    await safeReply(ctx, text, extra);
    return;
  }
  const chunks: string[] = [];
  let current = text;
  while (current.length > 0) {
    if (current.length <= MAX_LENGTH) {
      chunks.push(current);
      break;
    }
    let splitAt = current.lastIndexOf("\n", MAX_LENGTH);
    if (splitAt <= 0) splitAt = MAX_LENGTH;
    chunks.push(current.substring(0, splitAt));
    current = current.substring(splitAt).trimStart();
  }
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await safeReply(ctx, chunks[i], isLast ? extra : { parse_mode: "HTML" });
  }
}

export function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN not set — bot disabled");
    return null;
  }

  const bot = new Telegraf(token);

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
        let projects;
        try {
          projects = await getProjects();
        } catch (dbErr) {
          const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          console.error("getProjects error:", dbErr);
          await safeReply(ctx, `❌ خطأ قاعدة البيانات:\n<code>${escapeHtml(msg.substring(0, 200))}</code>`, { parse_mode: "HTML" });
          return;
        }

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
        const projectName = escapeHtml(project?.name ?? "");
        await safeEdit(ctx,
          `✅ تم اختيار المشروع: <b>${projectName}</b>\n\n` +
          "• أرسل أي سؤال برمجي للمحادثة مع الـ AI\n" +
          "• أضف تعليمات لهذا المشروع من القائمة\n" +
          "• احصل على API Token لأي AI Agent",
          { parse_mode: "HTML", ...mainKeyboard() }
        );
        return;
      }

      if (data === "new_project") {
        userStates.set(userId, { action: "new_project" });
        await safeEdit(ctx,
          "📝 أرسل <b>اسم المشروع الجديد</b> الآن:\n(مثلاً: Blockchain App أو ERP System)",
          { parse_mode: "HTML" }
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
        const projectName = escapeHtml(project?.name ?? "");
        await safeEdit(ctx,
          `💡 أرسل التعليمات أو الاستراتيجية لمشروع <b>${projectName}</b>:\n\n` +
          "سيقوم الذكاء الاصطناعي بتحليلها وإعطائها اسماً تلقائياً\n" +
          "يمكن لأي وكيل برمجي استدعاؤها لاحقاً باسمها عبر API",
          { parse_mode: "HTML" }
        );
        return;
      }

      if (data === "list_knowledge") {
        let session;
        try {
          session = await getUserSession(userId);
        } catch (dbErr) {
          const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          console.error("getUserSession error:", dbErr);
          await safeReply(ctx, `❌ خطأ:\n<code>${escapeHtml(msg.substring(0, 200))}</code>`, { parse_mode: "HTML" });
          return;
        }

        if (!session?.active_project_id) {
          await safeReply(ctx, "⚠️ لم تختر مشروعاً بعد.", mainKeyboard());
          return;
        }

        let project, knowledge;
        try {
          project = await getProjectById(session.active_project_id);
          knowledge = await getKnowledge(session.active_project_id);
        } catch (dbErr) {
          const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          console.error("getKnowledge error:", dbErr);
          await safeReply(ctx, `❌ خطأ:\n<code>${escapeHtml(msg.substring(0, 200))}</code>`, { parse_mode: "HTML" });
          return;
        }

        const projectName = escapeHtml(project?.name ?? "");

        if (!knowledge.length) {
          await safeReply(ctx,
            `📋 لا توجد تعليمات لمشروع <b>${projectName}</b> بعد.`,
            { parse_mode: "HTML", ...mainKeyboard() }
          );
          return;
        }

        let text = `📋 تعليمات مشروع <b>${projectName}</b>:\n\n`;
        knowledge.forEach((k, i) => {
          const label = k.label ? `🏷 <code>${escapeHtml(k.label)}</code>` : "🏷 بدون اسم";
          const summary = k.summary ? `\n📌 ${escapeHtml(k.summary)}` : "";
          text += `${i + 1}. ${label}${summary}\n\n`;
        });

        await sendLongMessage(ctx, text, { parse_mode: "HTML", ...mainKeyboard() });
        return;
      }

      if (data === "get_token") {
        const session = await getUserSession(userId);
        if (!session?.active_project_id) {
          await safeReply(ctx, "⚠️ لم تختر مشروعاً بعد.", mainKeyboard());
          return;
        }
        const project = await getProjectById(session.active_project_id);
        if (!project) return;
        const base = process.env.API_BASE_URL ?? "https://knowledge-base-bot.onrender.com";
        const projectName = escapeHtml(project.name);
        await safeReply(ctx,
          `🔑 <b>API Token لمشروع ${projectName}</b>\n\n` +
          `Token:\n<code>${escapeHtml(project.api_token)}</code>\n\n` +
          `📡 <b>نقاط الـ API:</b>\n\n` +
          `• كل التعليمات: <code>GET ${base}/api/project/knowledge</code>\n` +
          `• تعليمة باسمها: <code>GET ${base}/api/project/knowledge/by-label/LABEL_NAME</code>\n` +
          `• محادثة: <code>POST ${base}/api/project/chat</code>\n` +
          `• التاريخ: <code>GET ${base}/api/project/history</code>\n\n` +
          `<b>Header مطلوب:</b>\n<code>Authorization: Bearer ${escapeHtml(project.api_token)}</code>\n\n` +
          `<b>مثال:</b>\n<code>GET ${base}/api/project/knowledge/by-label/mev_arbitrage_strategy</code>`,
          { parse_mode: "HTML", ...mainKeyboard() }
        );
        return;
      }

      if (data === "back_main") {
        await safeEdit(ctx, "القائمة الرئيسية:", mainKeyboard());
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Callback error:", err);
      await safeReply(ctx, `❌ خطأ غير متوقع:\n<code>${escapeHtml(msg.substring(0, 200))}</code>\n\nأرسل /menu`, { parse_mode: "HTML" });
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
          const projectName = escapeHtml(project.name);
          await ctx.reply(
            `✅ تم إنشاء مشروع <b>${projectName}</b>!\n\n🔑 API Token:\n<code>${escapeHtml(project.api_token)}</code>\n\nأضف تعليمات أو ابدأ المحادثة:`,
            { parse_mode: "HTML", ...mainKeyboard() }
          );
        } catch (err: any) {
          userStates.delete(userId);
          if (err?.code === "23505") {
            const safeName = escapeHtml(name);
            await ctx.reply(
              `❌ اسم المشروع "<b>${safeName}</b>" موجود بالفعل.\n\nاختر مشروعاً مختلفاً:`,
              { parse_mode: "HTML", ...mainKeyboard() }
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

        userStates.delete(userId);

        const analyzing = await ctx.reply("🧠 جاري تحليل التعليمات وإعطاؤها اسماً...");

        let label: string;
        let summary: string;
        try {
          const analyzed = await analyzeAndNameKnowledge(text.trim());
          label = analyzed.label;
          summary = analyzed.summary;
        } catch {
          label = "knowledge_" + Date.now();
          summary = text.trim().substring(0, 150);
        }

        await addKnowledge(session.active_project_id, text.trim(), label, summary);
        await ctx.telegram.deleteMessage(ctx.chat.id, analyzing.message_id).catch(() => {});

        const project = await getProjectById(session.active_project_id);
        const projectName = escapeHtml(project?.name ?? "");
        const base = process.env.API_BASE_URL ?? "https://knowledge-base-bot.onrender.com";

        await ctx.reply(
          `✅ تم حفظ التعليمات لمشروع <b>${projectName}</b>!\n\n` +
          `🏷 <b>الاسم التلقائي:</b> <code>${escapeHtml(label)}</code>\n\n` +
          `📌 <b>الملخص:</b> ${escapeHtml(summary)}\n\n` +
          `🔗 <b>استدعاء عبر API:</b>\n<code>GET ${base}/api/project/knowledge/by-label/${escapeHtml(label)}</code>`,
          { parse_mode: "HTML", ...mainKeyboard() }
        );
        return;
      }

      const session = await getUserSession(userId);
      if (!session?.active_project_id) {
        await ctx.reply("⚠️ لم تختر مشروعاً بعد. اختر مشروعاً للبدء في المحادثة:", mainKeyboard());
        return;
      }

      const project = await getProjectById(session.active_project_id);
      const projectName = escapeHtml(project?.name ?? "");
      const typing = await ctx.reply(`⏳ جاري التحليل للمشروع <b>${projectName}</b>...`, { parse_mode: "HTML" });

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

import { Telegraf, Markup } from "telegraf";
import {
  getProjects,
  createProject,
  getKnowledge,
  addKnowledge,
  getUserSession,
  setUserSession,
  getProjectById,
} from "./database.js";
import { getAiResponse, analyzeAndNameKnowledge, getEmbedding } from "./ai.js";

const API_BASE_URL = process.env.API_BASE_URL || "https://knowledge-base-bot.onrender.com";

type BotState = { action?: "new_project" | "add_knowledge" | "idle" };
const userStates = new Map<number, BotState>();

function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📁 مشاريعي", "list_projects")],
    [Markup.button.callback("➕ مشروع جديد", "new_project")],
    [Markup.button.callback("🔍 فحص قاعدة البيانات", "db_test")],
  ]);
}

function getProjectMenu(projectId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📚 عرض المعرفة", `view_knowledge_${projectId}`)],
    [Markup.button.callback("✍️ إضافة معرفة", `add_knowledge_${projectId}`)],
    [Markup.button.callback("🔑 مفتاح API", `show_token_${projectId}`)],
    [Markup.button.callback("🔙 العودة", "list_projects")],
  ]);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN not set — bot disabled");
    return null;
  }

  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const name = ctx.from?.first_name ?? "صديقي";
    userStates.delete(ctx.from!.id);
    await ctx.reply(
      `مرحباً بك يا ${name} في Knowledge Base Bot! 🚀\n\n` +
      "أنا مساعدك لتحويل مشروعك إلى 'مصدر حقيقة' (Source of Truth) لوكلاء الذكاء الاصطناعي.\n\n" +
      "اختر ما تريد:",
      getMainMenu()
    );
  });

  bot.command("menu", async (ctx) => {
    userStates.delete(ctx.from!.id);
    await ctx.reply("القائمة الرئيسية:", getMainMenu());
  });

  bot.action("list_projects", async (ctx) => {
    const projects = await getProjects();
    if (projects.length === 0) {
      return ctx.editMessageText("لا توجد مشاريع حالياً. ابدأ بإنشاء مشروعك الأول!", 
        Markup.inlineKeyboard([[Markup.button.callback("➕ إنشاء مشروع", "new_project")]]));
    }
    const buttons = projects.map((p) => [Markup.button.callback(`📌 ${p.name}`, `select_project_${p.id}`)]);
    buttons.push([Markup.button.callback("🔙 العودة", "menu")]);
    await ctx.editMessageText("اختر مشروعاً:", Markup.inlineKeyboard(buttons));
  });

  bot.action("new_project", async (ctx) => {
    userStates.set(ctx.from!.id, { action: "new_project" });
    await ctx.reply("📝 أرسل اسم المشروع الجديد الآن:");
  });

  bot.action(/^select_project_(\d+)$/, async (ctx) => {
    const projectId = parseInt(ctx.match[1]);
    const project = await getProjectById(projectId);
    if (!project) return ctx.reply("المشروع غير موجود.");
    await setUserSession(ctx.from!.id, projectId);
    await ctx.editMessageText(
      `✅ تم اختيار المشروع: <b>${escapeHtml(project.name)}</b>\n${escapeHtml(project.description || "لا يوجد وصف")}\n\nماذا تريد أن تفعل؟`,
      { parse_mode: "HTML", ...getProjectMenu(projectId) }
    );
  });

  bot.action(/^add_knowledge_(\d+)$/, async (ctx) => {
    const projectId = parseInt(ctx.match[1]);
    userStates.set(ctx.from!.id, { action: "add_knowledge" });
    await ctx.reply("💡 أرسل المعرفة الجديدة (نص، كود، أو تعليمات) لمشروعك:");
  });

  bot.action(/^view_knowledge_(\d+)$/, async (ctx) => {
    const projectId = parseInt(ctx.match[1]);
    const project = await getProjectById(projectId);
    const knowledge = await getKnowledge(projectId);
    if (knowledge.length === 0) return ctx.reply("لا توجد معرفة مخزنة لهذا المشروع.");
    
    let text = `📚 المعرفة المخزنة لمشروع <b>${escapeHtml(project?.name || "")}</b>:\n\n`;
    knowledge.forEach((k, i) => {
      text += `${i + 1}. 🔹 [${escapeHtml(k.category || "general")}] <code>${escapeHtml(k.label || "")}</code>\n📌 ${escapeHtml(k.summary || "")}\n\n`;
    });
    
    if (text.length > 4000) {
      await ctx.reply(text.substring(0, 4000), { parse_mode: "HTML" });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", ...getProjectMenu(projectId) });
    }
  });

  bot.action(/^show_token_(\d+)$/, async (ctx) => {
    const projectId = parseInt(ctx.match[1]);
    const project = await getProjectById(projectId);
    if (!project) return ctx.reply("المشروع غير موجود.");
    await ctx.reply(
      `🔑 مفتاح API لمشروع <b>${escapeHtml(project.name)}</b>:\n\n` +
      `<code>${escapeHtml(project.api_token)}</code>\n\n` +
      `استخدمه في الـ Header:\n<code>Authorization: Bearer <token></code>\n\n` +
      `📖 التوثيق: ${API_BASE_URL}/api-docs`,
      { parse_mode: "HTML" }
    );
  });

  bot.action("db_test", async (ctx) => {
    try {
      const projects = await getProjects();
      await ctx.reply(`✅ قاعدة البيانات تعمل.\nعدد المشاريع: ${projects.length}`);
    } catch (err) {
      await ctx.reply(`❌ خطأ في قاعدة البيانات: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.action("menu", async (ctx) => {
    userStates.delete(ctx.from!.id);
    await ctx.editMessageText("القائمة الرئيسية:", getMainMenu());
  });

  bot.on("message", async (ctx) => {
    if (!("text" in ctx.message)) return;
    const userId = ctx.from.id;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const state = userStates.get(userId);

    if (state?.action === "new_project") {
      try {
        const project = await createProject(text.trim());
        await setUserSession(userId, project.id);
        userStates.set(userId, { action: "idle" });
        await ctx.reply(`✅ تم إنشاء المشروع: <b>${escapeHtml(project.name)}</b>`, { parse_mode: "HTML", ...getMainMenu() });
      } catch (err) {
        await ctx.reply("❌ حدث خطأ أثناء إنشاء المشروع. ربما الاسم موجود بالفعل.");
      }
    } else if (state?.action === "add_knowledge") {
      const session = await getUserSession(userId);
      if (!session?.active_project_id) return ctx.reply("يرجى اختيار مشروع أولاً.");
      
      const analyzing = await ctx.reply("🧠 جاري تحليل المعرفة وتوليد الـ Embeddings... ⏳");
      
      try {
        const analyzed = await analyzeAndNameKnowledge(text.trim());
        const embedding = await getEmbedding(text.trim());
        
        await addKnowledge(
          session.active_project_id,
          text.trim(),
          analyzed.label,
          analyzed.summary,
          analyzed.category,
          analyzed.metadata,
          embedding
        );
        
        await ctx.telegram.deleteMessage(ctx.chat.id, analyzing.message_id).catch(() => {});
        userStates.set(userId, { action: "idle" });
        await ctx.reply(
          `✅ تمت إضافة المعرفة بنجاح!\n\n` +
          `🏷 التصنيف: <b>${escapeHtml(analyzed.category)}</b>\n` +
          `📌 الاسم: <code>${escapeHtml(analyzed.label)}</code>\n` +
          `📝 الملخص: ${escapeHtml(analyzed.summary)}`,
          { parse_mode: "HTML", ...getProjectMenu(session.active_project_id) }
        );
      } catch (err) {
        console.error("Add knowledge error:", err);
        await ctx.reply("❌ حدث خطأ أثناء إضافة المعرفة.");
      }
    } else {
      // General chat
      const session = await getUserSession(userId);
      if (!session?.active_project_id) return ctx.reply("يرجى اختيار مشروع أولاً من القائمة.", getMainMenu());
      
      const typing = await ctx.reply("⏳ جاري التفكير...");
      try {
        const reply = await getAiResponse(session.active_project_id, text, userId);
        await ctx.telegram.deleteMessage(ctx.chat.id, typing.message_id).catch(() => {});
        await ctx.reply(reply);
      } catch (err) {
        await ctx.telegram.deleteMessage(ctx.chat.id, typing.message_id).catch(() => {});
        await ctx.reply("❌ حدث خطأ في الذكاء الاصطناعي.");
      }
    }
  });

  return bot;
}

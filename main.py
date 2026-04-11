import logging
import os
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ConversationHandler,
    filters,
    ContextTypes
)
from database import init_db, add_project, get_projects, set_user_project, get_user_project, add_knowledge, add_chat_history, get_project_by_name
from ai_engine import get_ai_response
import threading
from health_check import run_health_check

# إعداد السجلات
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# جلب توكن البوت من المتغيرات البيئية
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

# حالات المحادثة
CHOOSING, TYPING_PROJECT_NAME, TYPING_KNOWLEDGE = range(3)

def get_main_keyboard():
    keyboard = [
        [InlineKeyboardButton("📁 مشاريعي", callback_data="list_projects")],
        [InlineKeyboardButton("➕ إنشاء مشروع جديد", callback_data="new_project_start")],
        [InlineKeyboardButton("💡 إضافة تعليمات", callback_data="add_knowledge_start")]
    ]
    return InlineKeyboardMarkup(keyboard)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_name = update.effective_user.first_name
    text = (
        f"مرحباً بك يا {user_name} في نظام إدارة المعرفة البرمجية الذكي! 🚀\n\n"
        "هذا النظام يساعدك على تخزين تعليمات مشاريعك لضمان عدم نسيان الـ AI لها.\n"
        "اختر ما تريد القيام به من الأزرار أدناه:"
    )
    if update.message:
        await update.message.reply_text(text, reply_markup=get_main_keyboard())
    else:
        await update.callback_query.edit_message_text(text, reply_markup=get_main_keyboard())
    return CHOOSING

async def list_projects_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    projects = get_projects()
    if not projects:
        keyboard = [[InlineKeyboardButton("➕ إنشاء أول مشروع", callback_data="new_project_start")]]
        await query.edit_message_text("لا توجد مشاريع حالياً. ابدأ بإنشاء مشروعك الأول:", reply_markup=InlineKeyboardMarkup(keyboard))
        return CHOOSING
    
    keyboard = [[InlineKeyboardButton(p[1], callback_data=f"select_{p[0]}")] for p in projects]
    keyboard.append([InlineKeyboardButton("🔙 العودة", callback_data="back_to_main")])
    reply_markup = InlineKeyboardMarkup(keyboard)
    await query.edit_message_text("اختر المشروع الذي تريد العمل عليه:", reply_markup=reply_markup)
    return CHOOSING

async def select_project_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    project_id = int(query.data.split("_")[1])
    set_user_project(update.effective_user.id, project_id)
    
    projects = get_projects()
    project_name = next((p[1] for p in projects if p[0] == project_id), "غير معروف")
    
    text = (
        f"✅ تم اختيار المشروع: *{project_name}*\n\n"
        "الآن يمكنك:\n"
        "1. إرسال أي سؤال برمجي وسأجيبك بناءً على معرفة هذا المشروع.\n"
        "2. إضافة تعليمات جديدة للمشروع عبر زر 'إضافة تعليمات'.\n"
        "3. التبديل لمشروع آخر في أي وقت."
    )
    keyboard = [
        [InlineKeyboardButton("💡 إضافة تعليمات لهذا المشروع", callback_data="add_knowledge_start")],
        [InlineKeyboardButton("🔙 العودة للمشاريع", callback_data="list_projects")]
    ]
    await query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    return CHOOSING

async def new_project_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text("يرجى إرسال *اسم المشروع* الجديد الآن (مثلاً: Blockchain App):", parse_mode="Markdown")
    return TYPING_PROJECT_NAME

async def save_project_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    project_name = update.message.text.strip()
    
    # محاولة إضافة المشروع
    project_id = add_project(project_name)
    
    try:
        if project_id:
            set_user_project(update.effective_user.id, project_id)
            await update.message.reply_text(
                f"✅ تم إنشاء المشروع '{project_name}' بنجاح وتم اختياره حالياً.\n"
                "يمكنك الآن البدء بإضافة التعليمات أو الدردشة مباشرة.",
                reply_markup=get_main_keyboard()
            )
        else:
            # إذا فشل الإضافة، قد يكون موجوداً بالفعل
            existing_project = get_project_by_name(project_name)
            if existing_project:
                set_user_project(update.effective_user.id, existing_project[0])
                await update.message.reply_text(
                    f"ℹ️ المشروع '{project_name}' موجود بالفعل. تم اختياره تلقائياً لتتمكن من العمل عليه.",
                    reply_markup=get_main_keyboard()
                )
            else:
                await update.message.reply_text(
                    f"❌ حدث خطأ في قاعدة البيانات أثناء محاولة إنشاء المشروع. يرجى التأكد من اتصال قاعدة البيانات والمحاولة مرة أخرى.",
                    reply_markup=get_main_keyboard()
                )
    except Exception as e:
        logging.error(f"Error in save_project_name: {e}")
        await update.message.reply_text(
            f"❌ حدث خطأ غير متوقع: {str(e)}",
            reply_markup=get_main_keyboard()
        )
    return CHOOSING

async def add_knowledge_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    project_id = get_user_project(user_id)
    
    if not project_id:
        if update.callback_query:
            await update.callback_query.answer("يرجى اختيار مشروع أولاً", show_alert=True)
            return await list_projects_handler(update, context)
        else:
            await update.message.reply_text("⚠️ يرجى اختيار مشروع أولاً من القائمة.")
            return await list_projects_handler(update, context)
    
    text = "يرجى إرسال *التعليمات أو البيانات* التي تريد إضافتها لهذا المشروع:"
    if update.callback_query:
        await update.callback_query.answer()
        await update.callback_query.edit_message_text(text, parse_mode="Markdown")
    else:
        await update.message.reply_text(text, parse_mode="Markdown")
    return TYPING_KNOWLEDGE

async def save_knowledge(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    project_id = get_user_project(user_id)
    content = update.message.text
    
    if not project_id:
        await update.message.reply_text("⚠️ حدث خطأ: لم يتم العثور على مشروع نشط. يرجى اختيار مشروع أولاً.")
        return CHOOSING

    add_knowledge(project_id, content)
    await update.message.reply_text(
        "✅ تمت إضافة التعليمات بنجاح إلى قاعدة معرفة المشروع.\n"
        "سألتزم بها في جميع إجاباتي القادمة لهذا المشروع.",
        reply_markup=get_main_keyboard()
    )
    return CHOOSING

async def handle_chat(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    project_id = get_user_project(user_id)
    
    if not project_id:
        await update.message.reply_text(
            "⚠️ لم تقم باختيار مشروع بعد. يرجى اختيار مشروع أو إنشاء واحد جديد للبدء.",
            reply_markup=get_main_keyboard()
        )
        return CHOOSING
    
    user_message = update.message.text
    wait_msg = await update.message.reply_text("🔍 جاري مراجعة تعليمات المشروع والرد عليك...")
    
    ai_response = get_ai_response(project_id, user_message)
    
    add_chat_history(project_id, "user", user_message)
    add_chat_history(project_id, "assistant", ai_response)
    
    await wait_msg.edit_text(ai_response)
    return CHOOSING

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("تم إلغاء العملية.", reply_markup=get_main_keyboard())
    return CHOOSING

if __name__ == '__main__':
    if not TOKEN:
        print("Error: TELEGRAM_BOT_TOKEN not found.")
        exit(1)
        
    # بدء خادم فحص الصحة في خلفية البرنامج لإرضاء Render
    health_thread = threading.Thread(target=run_health_check, daemon=True)
    health_thread.start()

    try:
        init_db()
    except Exception as e:
        logging.error(f"Database initialization failed: {e}")
        # We continue to allow the bot to start even if DB fails initially
        
    app = ApplicationBuilder().token(TOKEN).build()
    logging.info("Bot application built successfully.")
    
    conv_handler = ConversationHandler(
        entry_points=[CommandHandler("start", start)],
        states={
            CHOOSING: [
                CallbackQueryHandler(list_projects_handler, pattern="^list_projects$"),
                CallbackQueryHandler(new_project_start, pattern="^new_project_start$"),
                CallbackQueryHandler(add_knowledge_start, pattern="^add_knowledge_start$"),
                CallbackQueryHandler(select_project_handler, pattern="^select_"),
                CallbackQueryHandler(start, pattern="^back_to_main$"),
                MessageHandler(filters.TEXT & (~filters.COMMAND), handle_chat)
            ],
            TYPING_PROJECT_NAME: [
                MessageHandler(filters.TEXT & (~filters.COMMAND), save_project_name)
            ],
            TYPING_KNOWLEDGE: [
                MessageHandler(filters.TEXT & (~filters.COMMAND), save_knowledge)
            ],
        },
        fallbacks=[CommandHandler("cancel", cancel), CommandHandler("start", start)],
        allow_reentry=True
    )
    
    app.add_handler(conv_handler)
    
    print("البوت يعمل الآن بواجهة تفاعلية...")
    app.run_polling(drop_pending_updates=True)

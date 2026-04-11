import logging
import os
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes
from database import init_db, add_project, get_projects, set_user_project, get_user_project, add_knowledge, add_chat_history
from ai_engine import get_ai_response

# إعداد السجلات
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# جلب توكن البوت من المتغيرات البيئية
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "مرحباً بك في نظام إدارة المعرفة البرمجية الذكي!\n\n"
        "يمكنك استخدام الأوامر التالية:\n"
        "/new_project [اسم المشروع] - لإنشاء مشروع جديد\n"
        "/projects - لعرض واختيار المشاريع الحالية\n"
        "/add_knowledge [التعليمات] - لإضافة تعليمات للمشروع الحالي\n"
        "أو ببساطة أرسل رسالة للدردشة مع الذكاء الاصطناعي بناءً على معرفة المشروع المختار."
    )

async def new_project(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("يرجى كتابة اسم المشروع بعد الأمر. مثال: /new_project Blockchain")
        return
    
    project_name = " ".join(context.args)
    project_id = add_project(project_name)
    
    if project_id:
        set_user_project(update.effective_user.id, project_id)
        await update.message.reply_text(f"تم إنشاء المشروع '{project_name}' بنجاح وتم اختياره كمشروع حالي.")
    else:
        await update.message.reply_text(f"المشروع '{project_name}' موجود بالفعل.")

async def list_projects(update: Update, context: ContextTypes.DEFAULT_TYPE):
    projects = get_projects()
    if not projects:
        await update.message.reply_text("لا توجد مشاريع حالياً. استخدم /new_project لإنشاء واحد.")
        return
    
    keyboard = [[InlineKeyboardButton(p[1], callback_data=f"select_{p[0]}")] for p in projects]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text("اختر المشروع الذي تريد العمل عليه:", reply_markup=reply_markup)

async def select_project(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    project_id = int(query.data.split("_")[1])
    set_user_project(update.effective_user.id, project_id)
    
    # جلب اسم المشروع
    projects = get_projects()
    project_name = next((p[1] for p in projects if p[0] == project_id), "غير معروف")
    
    await query.edit_message_text(f"تم اختيار المشروع: {project_name}. يمكنك الآن إضافة تعليمات أو البدء بالدردشة.")

async def add_knowledge_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    project_id = get_user_project(update.effective_user.id)
    if not project_id:
        await update.message.reply_text("يرجى اختيار مشروع أولاً باستخدام /projects")
        return
    
    if not context.args:
        await update.message.reply_text("يرجى كتابة التعليمات بعد الأمر. مثال: /add_knowledge استخدم Solidity الإصدار 0.8.0")
        return
    
    content = " ".join(context.args)
    add_knowledge(project_id, content)
    await update.message.reply_text("تمت إضافة التعليمات إلى قاعدة معرفة المشروع بنجاح.")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    project_id = get_user_project(user_id)
    
    if not project_id:
        await update.message.reply_text("يرجى اختيار مشروع أولاً باستخدام /projects أو إنشاء واحد جديد.")
        return
    
    user_message = update.message.text
    
    # إرسال رسالة انتظار
    wait_msg = await update.message.reply_text("جاري التفكير بناءً على تعليمات المشروع...")
    
    # الحصول على رد الذكاء الاصطناعي
    ai_response = get_ai_response(project_id, user_message)
    
    # حفظ في التاريخ
    add_chat_history(project_id, "user", user_message)
    add_chat_history(project_id, "assistant", ai_response)
    
    await wait_msg.edit_text(ai_response)

if __name__ == '__main__':
    if not TOKEN:
        print("خطأ: لم يتم ضبط TELEGRAM_BOT_TOKEN في المتغيرات البيئية.")
        exit(1)
        
    init_db()
    app = ApplicationBuilder().token(TOKEN).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("new_project", new_project))
    app.add_handler(CommandHandler("projects", list_projects))
    app.add_handler(CommandHandler("add_knowledge", add_knowledge_cmd))
    app.add_handler(CallbackQueryHandler(select_project, pattern="^select_"))
    app.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), handle_message))
    
    print("البوت يعمل الآن...")
    app.run_polling()

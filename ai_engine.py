from openai import OpenAI
import os
from database import get_project_knowledge, get_chat_history

# إعداد العميل لـ DeepSeek
client = OpenAI(
    api_key="sk-c08327d26b4044f9aed9d75e3d05896b",
    base_url="https://api.deepseek.com"
)

def get_ai_response(project_id, user_message):
    # جلب المعرفة الخاصة بالمشروع
    knowledge = get_project_knowledge(project_id)
    
    # بناء سياق المعرفة بشكل منظم
    if knowledge:
        knowledge_context = "إليك القواعد والتعليمات الصارمة لهذا المشروع:\n"
        for i, k in enumerate(knowledge, 1):
            knowledge_context += f"{i}. {k}\n"
    else:
        knowledge_context = "لا توجد تعليمات خاصة مخزنة لهذا المشروع بعد."
    
    # جلب تاريخ المحادثة (آخر 10 رسائل للحفاظ على السياق دون تجاوز حدود التوكنات)
    history = get_chat_history(project_id, limit=10)
    
    # بناء الرسائل لـ DeepSeek
    system_prompt = (
        "أنت خبير برمجي ومساعد ذكي متخصص. مهمتك هي مساعدة المستخدم في مشروعه البرمجي.\n"
        "لقد تم تزويدك بقاعدة معرفة خاصة بهذا المشروع تحديداً.\n"
        "يجب عليك الالتزام التام بالتعليمات الموجودة في قاعدة المعرفة.\n"
        "إذا تعارضت تعليمات المستخدم الحالية مع قاعدة المعرفة، نبهه لذلك ولكن اتبع قاعدة المعرفة إلا إذا طلب تغييرها.\n\n"
        f"--- قاعدة معرفة المشروع ---\n{knowledge_context}\n--------------------------"
    )
    
    messages = [{"role": "system", "content": system_prompt}]
    
    # إضافة التاريخ
    for role, content in history:
        messages.append({"role": role, "content": content})
    
    # إضافة الرسالة الحالية
    messages.append({"role": "user", "content": user_message})
    
    try:
        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=messages,
            stream=False,
            temperature=0.7 # توازن بين الإبداع والدقة
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"Error in DeepSeek API: {e}")
        return f"عذراً، حدث خطأ أثناء الاتصال بمحرك الذكاء الاصطناعي: {str(e)}"

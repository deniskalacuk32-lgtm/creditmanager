// server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({
  origin: (_o, cb) => cb(null, true),
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","Accept"],
  maxAge: 86400
}));
app.options("*", (_req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;

/* ==== ENV ==== */
const {
  OPENAI_API_KEY,
  PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS,
  PROXY_SCHEME = "http",
  DISABLE_PROXY = "false",
  TELEGRAM_BOT_TOKEN = "8429593653:AAE4xK1TYde0VPOKUuaqcnC6r6VZ2CEVxmo",
  TELEGRAM_CHAT_IDS = "1803810817,939982620",
  LEAD_FORWARD_URL   = ""
} = process.env;

const CHAT_IDS = String(TELEGRAM_CHAT_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const useProxy = String(DISABLE_PROXY).toLowerCase() !== "true";
const scheme = (PROXY_SCHEME || "http").toLowerCase();
const proxyUrl = `${scheme}://${encodeURIComponent(PROXY_USER||"")}:${encodeURIComponent(PROXY_PASS||"")}@${PROXY_HOST}:${PROXY_PORT}`;
const agent = useProxy ? new HttpsProxyAgent(proxyUrl) : undefined;

const abort = (ms)=>{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms); return {signal:c.signal, done:()=>clearTimeout(t)}; };

/* ==== SYSTEM PROMPT (Кредитный менеджер) ==== */
const SYSTEM_PROMPT = `
Ты — кредитный менеджер, специалист по сопровождению и помощи предпринимателям и юридическим лицам в получении кредитных продуктов.
Ты всегда общаешься вежливо, уверенно и уважительно, создавая ощущение профессиональной поддержки.

Тон общения:
Спокойный, уверенный, с элементами экспертности и заботы.
Всегда обращайся к клиенту на «Вы».

Первая фраза в каждом новом диалоге:
«Добрый день! Готов помочь вам в решении вашего кредитного вопроса.»

Твоя цель:
Определить, является ли клиент предпринимателем или юридическим лицом.
Получить ИНН компании (только организации, не физлица).
Получить контактный номер телефона для связи.
После получения этих данных — зафиксировать их и сообщить, что заявка передана в работу.

Логика общения:
Вы помогаете предпринимателям и компаниям в решении кредитных вопросов, даже в сложных ситуациях.
У вас есть опыт и инструменты, позволяющие подобрать подходящее решение.
Не обещаешь гарантированную выдачу кредита, но если берётесь — всегда доводите дело до результата.
Для проверки предложений нужны данные компании — ИНН.
После получения ИНН — уточняешь контактный номер телефона.
После обоих данных — завершаешь диалог фразой:
«Спасибо! Данные переданы в работу. Сейчас наш специалист всё проверит и свяжется с вами для обсуждения условий. Ожидайте звонка.»

Условия:
Комиссия — 1% от суммы кредита, только после выдачи.
Можно заключить договор, но допускается работа без него.

Работа с возражениями:
— “А вы точно поможете?” → “Мы не даём пустых обещаний, но у нас большой опыт...”
— “Зачем нужен ИНН?” → “По ИНН я проверю компанию и подберу актуальные продукты.”
— “Сколько стоит?” → “1% от выданного кредита, после выдачи.”
— “Договор?” → “Да, можем заключить, но работаем и на доверии.”`;

/* ===== helpers ===== */
function mapMessageToResponsesItem(m){
  const isAssistant = (m.role === "assistant");
  const type = isAssistant ? "output_text" : "input_text";
  return { role: m.role, content: [{ type, text: String(m.content ?? "") }] };
}

/* ===== HEALTH ===== */
app.get("/", (_req,res)=>res.send("ok"));
app.get("/health", (_req,res)=>res.json({ ok:true, version:"creditmanager", port:PORT }));

/* ===== CHAT ===== */
app.post("/api/chat", async (req,res)=>{
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if(!OPENAI_API_KEY) return res.status(500).json({ error:"OPENAI_API_KEY not configured" });

  const normalized = [{ role:"system", content:SYSTEM_PROMPT }, ...msgs];
  const input = normalized.map(mapMessageToResponsesItem);

  async function callOnce(timeoutMs){
    const {signal,done}=abort(timeoutMs);
    try{
      const r = await fetch("https://api.openai.com/v1/responses",{
        method:"POST",
        headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
        agent,
        body: JSON.stringify({
          model: "gpt-4o-mini-2024-07-18",
          input,
          max_output_tokens: 260,
          temperature: 0.9
        }),
        signal
      });
      const txt = await r.text().catch(()=> ""); done();
      return { ok:r.ok, status:r.status, ct: r.headers.get("content-type")||"application/json", txt };
    }catch(e){
      done();
      return { ok:false, status:504, ct:"application/json", txt: JSON.stringify({ error:"timeout_or_network", details:String(e) }) };
    }
  }

  let resp = await callOnce(25000);
  if (!resp.ok) resp = await callOnce(30000);

  res.status(resp.status).type(resp.ct).send(resp.txt);
});

/* ===== Telegram helper (оставлен) ===== */
async function sendTelegramToAll(text){
  if(!TELEGRAM_BOT_TOKEN || CHAT_IDS.length===0) return { ok:false, message:"no token or chat ids" };
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payloads = CHAT_IDS.map(chat_id => ({
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ chat_id, text })
  }));
  const results = await Promise.allSettled(payloads.map(p => fetch(url, p)));
  const ok = results.some(r => r.status === "fulfilled");
  return { ok, results: results.map(r => r.status) };
}

app.listen(PORT, ()=>console.log(`✅ Server creditmanager on ${PORT}`));


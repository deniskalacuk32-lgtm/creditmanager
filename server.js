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

  LEAD_FORWARD_URL   = "" // опционально
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
Всегда вежливый, уверенный, на «Вы». Первая фраза в новом диалоге: «Добрый день! Готов помочь вам в решении вашего кредитного вопроса.»

Цель:
— Выяснить, предприниматель/юрлицо ли клиент.
— Получить ИНН организации (не физлица).
— Получить контактный номер телефона.
— После получения этих данных — зафиксировать и сообщить, что заявка передана в работу: «Спасибо! Данные переданы в работу. Сейчас наш специалист всё проверит и свяжется с вами для обсуждения условий. Ожидайте звонка.»

Логика:
— Мы помогаем даже в сложных ситуациях; у нас опыт и инструменты, но не даём пустых гарантий.
— По ИНН проверяем компанию и подбираем доступные продукты.
— Возражения:
   * «А вы точно поможете?» → «Не обещаем заранее, но у нас большой опыт…»
   * «Зачем ИНН?» → «Чтобы проверить компанию и доступные продукты.»
   * «Сколько стоит?» → «1% от выданного кредита, оплата после выдачи.»
   * «Договор?» → «Можем заключить, но работаем и на доверии.»

Правила интерфейсной логики:
— Если клиент не указал ФИО и год рождения, кратко попроси указать их одним сообщением (пример: «Иванов Иван Иванович, 1986») — если это нужно по сценарию.
— После получения ИНН и телефона подтверди фиксацию и передачу заявки в работу.
— Отвечай кратко и по существу, 1–2 предложения.
`;

/* ===== helpers ===== */
function mapMessageToResponsesItem(m){
  const isAssistant = (m.role === "assistant");
  const type = isAssistant ? "output_text" : "input_text";
  return { role: m.role, content: [{ type, text: String(m.content ?? "") }] };
}

/* ===== HEALTH ===== */
app.get("/", (_req,res)=>res.send("ok"));
app.get("/health", (_req,res)=>res.json({ ok:true, version:"creditmanager", port:PORT }));

/* ===== CHAT (non-stream) ===== */
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
          max_output_tokens: 80,   // короче → быстрее
          temperature: 0.7
        }),
        signal
      });
      const txt = await r.text().catch(()=> ""); done();
      return { ok:r.ok, status:r.status, ct: r.headers.get("content-type")||"application/json", txt };
    }catch(e){
      done();
      return { ok:false, status:504, ct:"application/json",
        txt: JSON.stringify({ error:"timeout_or_network", details:String(e) }) };
    }
  }

  // Надёжный ретрай как раньше
  let resp = await callOnce(25000);
  if (!resp.ok) resp = await callOnce(30000);

  res.status(resp.status).type(resp.ct).send(resp.txt);
});

/* ===== Telegram helper ===== */
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

/* ===== ЛИДЫ: /lead ===== */
app.post("/lead", async (req, res)=>{
  try{
    const p = req.body || {};
    const name  = String(p.name||"").trim();
    const phone = String(p.phone||"").trim();
    const date  = String(p.date||"").trim();
    const time  = String(p.time||"").trim();
    const inn   = String(p.inn||"").trim();
    const note  = String(p.note||"").trim();
    const source= String(p.source||"web").trim();
    const createdAt = String(p.createdAt||new Date().toISOString());

    if(!name || !phone || !date){
      return res.status(400).json({ ok:false, error:"name/phone/date required" });
    }

    const tgText =
`🆕 Заявка на консультацию по кредиту
Контакт: ${name}
Телефон: ${phone}
Дата звонка: ${date}${time?`\nВремя: ${time}`:''}${inn?`\nИНН: ${inn}`:''}${note?`\nКомментарий: ${note}`:''}
Источник: ${source}
Создано: ${createdAt}`;

    const tg = await sendTelegramToAll(tgText);

    // Доп. форвард (если задан)
    let fwdOk = false, fwdResp = null;
    if(LEAD_FORWARD_URL){
      const r = await fetch(LEAD_FORWARD_URL,{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(p)
      });
      fwdOk = r.ok;
      fwdResp = await r.text().catch(()=>null);
    }

    return res.json({ ok:true, telegram: tg.ok, tgResults: tg.results, forward: fwdOk, fwdResp });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ===== совместимость ===== */
app.post("/", (req,res)=>{ req.url="/api/chat"; app._router.handle(req,res,()=>{}); });

app.listen(PORT, ()=>console.log(`✅ Server creditmanager on ${PORT}`));

/* ==== Keep Render awake (необязательно, но полезно) ==== */
setInterval(() => {
  fetch(`https://creditmanager.onrender.com/health`).catch(()=>{});
}, 240000); // каждые ~4 минуты

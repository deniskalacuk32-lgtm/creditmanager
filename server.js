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

  LEAD_FORWARD_URL = ""
} = process.env;

const CHAT_IDS = String(TELEGRAM_CHAT_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const useProxy = String(DISABLE_PROXY).toLowerCase() !== "true";
const scheme = (PROXY_SCHEME || "http").toLowerCase();
const proxyUrl = `${scheme}://${encodeURIComponent(PROXY_USER||"")}:${encodeURIComponent(PROXY_PASS||"")}@${PROXY_HOST}:${PROXY_PORT}`;
const agent = useProxy ? new HttpsProxyAgent(proxyUrl) : undefined;

const abort = (ms)=>{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms); return {signal:c.signal, done:()=>clearTimeout(t)}; };

/* ==== SYSTEM PROMPT ==== */
const SYSTEM_PROMPT = `
Ты — кредитный менеджер, специалист по сопровождению предпринимателей и юрлиц.
Всегда вежливый, уверенный, на «Вы». Первая фраза: «Добрый день! Готов помочь вам в решении вашего кредитного вопроса.»

Цель: 1) понять, ИП/юрлицо; 2) получить ИНН организации; 3) получить телефон; 4) подтвердить приём в работу:
«Спасибо! Данные переданы в работу. Сейчас наш специалист всё проверит и свяжется с вами для обсуждения условий. Ожидайте звонка.»

Мы помогаем даже в сложных кейсах, но без пустых гарантий. По ИНН проверяем доступные продукты.
Цена: 1% от выданного кредита, оплата после выдачи. Договор возможен.

Отвечай кратко (1–2 предложения), без длинных вступлений.
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
          max_output_tokens: 80,
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

/* ===== /lead ===== */
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

/* ==== Keep Render awake ==== */
setInterval(() => {
  fetch(`https://creditmanager.onrender.com/health`).catch(()=>{});
}, 240000);

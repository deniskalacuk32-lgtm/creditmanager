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

// === ENV ===
const {
  OPENAI_API_KEY,
  PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS,
  PROXY_SCHEME = "http",
  DISABLE_PROXY = "false"
} = process.env;

const useProxy = String(DISABLE_PROXY).toLowerCase() !== "true";
const scheme = (PROXY_SCHEME || "http").toLowerCase();
const proxyUrl = `${scheme}://${encodeURIComponent(PROXY_USER||"")}:${encodeURIComponent(PROXY_PASS||"")}@${PROXY_HOST}:${PROXY_PORT}`;
const agent = useProxy ? new HttpsProxyAgent(proxyUrl) : undefined;

const abort = (ms)=>{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms); return {signal:c.signal, done:()=>clearTimeout(t)}; };

// === SYSTEM PROMPT (Кредитный менеджер) ===
const SYSTEM_PROMPT = `
Ты — кредитный менеджер, специалист по сопровождению и помощи предпринимателям и юридическим лицам в получении кредитных продуктов.
Всегда вежливый, уверенный, на «Вы».

Первая фраза: «Добрый день! Готов помочь вам в решении вашего кредитного вопроса.»

Цели:
— Определить: предприниматель (ИП) или юрлицо.
— Получить ИНН компании (только организации/ИП, не физлица).
— Получить контактный номер телефона.
После получения ИНН и телефона — зафиксировать и завершить:
«Спасибо! Данные переданы в работу. Сейчас наш специалист всё проверит и свяжется с вами для обсуждения условий. Ожидайте звонка.»

Пояснения:
— Помогаем даже в сложных случаях, без пустых гарантий. Есть опыт и инструменты для подбора решений.
— ИНН нужен для проверки доступных предложений.

Условия:
— Комиссия 1% от выданной суммы, оплата после выдачи. По желанию — можем заключить договор.

Работа с возражениями (кратко, по делу).
Отвечай кратко: 1–2 предложения без лишних вступлений.
`;

// ===== helpers =====
function mapMessageToResponsesItem(m){
  const isAssistant = (m.role === "assistant");
  const type = isAssistant ? "output_text" : "input_text";
  return { role: m.role, content: [{ type, text: String(m.content ?? "") }] };
}

// === HEALTH ===
app.get("/", (_req,res)=>res.send("ok"));
app.get("/__version", (_req,res)=>res.send("creditmanager-v3.5 ✅"));
app.get("/health", (_req,res)=>res.json({
  ok:true, version:"creditmanager-v3.5", port:PORT,
  proxy:{ enabled:useProxy, scheme, host:PROXY_HOST, port:PROXY_PORT, user:!!PROXY_USER },
  openaiKeySet: !!OPENAI_API_KEY
}));

// === обычный (non-stream) ===
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
          model:"gpt-4o-mini-2024-07-18",
          input,
          max_output_tokens:120
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

  // те же тайминги: 25s, ретрай 30s
  let resp = await callOnce(25000);
  if (!resp.ok) resp = await callOnce(30000);

  res.status(resp.status).type(resp.ct).send(resp.txt);
});

// === STREAM (SSE) — оставил как в твоём сервере ===
app.post("/api/chat-stream", async (req, res) => {
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  const normalized = [{ role: "system", content: SYSTEM_PROMPT }, ...msgs];
  const input = normalized.map(mapMessageToResponsesItem);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const { signal, done } = abort(30000);

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      agent,
      body: JSON.stringify({
        model: "gpt-4o-mini-2024-07-18",
        input,
        max_output_tokens: 120,
        stream: true
      }),
      signal
    });

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(()=> "");
      res.write(`data: ${JSON.stringify({ type:"response.error", message:`HTTP ${upstream.status}: ${txt}` })}\n\n`);
      return res.end();
    }

    for await (const chunk of upstream.body) res.write(chunk);
    done(); res.end();
  } catch (e) {
    done();
    res.write(`data: ${JSON.stringify({ type:"response.error", message:String(e?.message || e) })}\n\n`);
    res.end();
  }
});

// совместимость
app.post("/", (req,res)=>{ req.url="/api/chat"; app._router.handle(req,res,()=>{}); });

app.listen(PORT, ()=>console.log(`✅ Server creditmanager-v3.5 on ${PORT}`));

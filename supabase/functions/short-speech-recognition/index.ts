import { serve } from "https://deno.land/std/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 百度 ASR dev_pid 方言映射
// 1537: 普通话, 1637: 粤语, 1638: 四川话, 1639: 东北话, 1640: 闽南语, 1536: 普通话（含标点）
const VALID_DEV_PIDS = new Set([1536, 1537, 1637, 1638, 1639, 1640]);

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  let speech: string;
  let len: number;
  let format: string;
  let rate: number;
  let cuid: string;
  let dev_pid: number;

  try {
    const body = await req.json();
    speech = body.speech;
    len = body.len;
    format = body.format ?? "wav";
    rate = body.rate ?? 16000;
    cuid = body.cuid ?? "miaoda-edge-cuid";
    // 方言 dev_pid：默认普通话 1537，前端可传入其他方言值
    dev_pid = VALID_DEV_PIDS.has(body.dev_pid) ? body.dev_pid : 1537;

    if (!speech) throw new Error("Missing speech");
    if (typeof len !== "number" || len <= 0) throw new Error("Missing or invalid len");
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("INTEGRATIONS_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const upstream = await fetch(
    "https://app-d04hti6zlz42-api-Aa2PZnjEw5NL-gateway.appmiaoda.com/server_api",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ format, rate, cuid, speech, len, dev_pid }),
    },
  );

  if (upstream.status === 429 || upstream.status === 402) {
    const errText = await upstream.text();
    return new Response(errText, {
      status: upstream.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!upstream.ok) {
    return new Response(
      JSON.stringify({ error: `Upstream error: ${upstream.status}` }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const data = await upstream.json();
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

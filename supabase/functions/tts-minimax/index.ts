import { serve } from "https://deno.land/std/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  let text: string;
  let voiceId: string;
  let model: string;
  let speed: number;
  let emotion: string | undefined;

  try {
    const body = await req.json();
    text = body.text;
    if (!text?.trim()) throw new Error("Missing text");
    // English_Graceful_Lady: MiniMax 英文优雅女声（有效音色 ID）
    voiceId = body.voice_id ?? "English_Graceful_Lady";
    model  = body.model  ?? "speech-02-turbo";
    speed  = body.speed  ?? 1.05;
    emotion = body.emotion;
    console.log(`[tts-minimax] 收到请求: text="${text.slice(0, 50)}", voice=${voiceId}, model=${model}`);
  } catch (e) {
    console.error("[tts-minimax] 解析请求体失败:", e);
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("INTEGRATIONS_API_KEY");
  if (!apiKey) {
    console.error("[tts-minimax] INTEGRATIONS_API_KEY 未配置");
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const voiceSetting: Record<string, unknown> = { voice_id: voiceId, speed, vol: 1.0 };
  if (emotion) voiceSetting.emotion = emotion;

  const requestBody = {
    model,
    text,
    stream: false,
    output_format: "url",       // 返回 CDN URL，前端直接播放，无需转存
    language_boost: "English",
    voice_setting: voiceSetting,
    audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000, channel: 1 },
  };

  console.log("[tts-minimax] 调用 MiniMax API...");
  let upstream: Response;
  try {
    upstream = await fetch(
      "https://app-d04hti6zlz42-api-DLEO7Bj0lORa-gateway.appmiaoda.com/v1/t2a_v2",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
    );
  } catch (e) {
    console.error("[tts-minimax] fetch MiniMax 失败:", e);
    return new Response(JSON.stringify({ error: "Network error calling MiniMax" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  console.log(`[tts-minimax] MiniMax 响应状态: ${upstream.status}`);

  if (!upstream.ok) {
    const errText = await upstream.text();
    console.error(`[tts-minimax] 上游 HTTP 错误 ${upstream.status}:`, errText);
    return new Response(
      JSON.stringify({ error: `Upstream error: ${upstream.status}`, detail: errText }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const result = await upstream.json();
  console.log("[tts-minimax] MiniMax base_resp:", JSON.stringify(result.base_resp));

  if (result.base_resp?.status_code !== 0) {
    const msg = `TTS error ${result.base_resp?.status_code}: ${result.base_resp?.status_msg}`;
    console.error("[tts-minimax]", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // output_format:"url" 时 data.audio 即为可直接播放的 CDN HTTPS URL
  const audioUrl = result.data?.audio as string;
  if (!audioUrl) {
    console.error("[tts-minimax] 未返回 audioUrl，result.data:", JSON.stringify(result.data));
    return new Response(
      JSON.stringify({ error: "No audio URL in response" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  console.log(`[tts-minimax] 成功，audioUrl=${audioUrl.slice(0, 80)}...`);
  return new Response(
    JSON.stringify({
      audioUrl,
      audioLength: result.extra_info?.audio_length ?? 0,
      usageCharacters: result.extra_info?.usage_characters ?? 0,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

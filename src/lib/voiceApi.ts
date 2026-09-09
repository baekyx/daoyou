import { supabase } from '@/db/supabase';
import type { Subtitle } from '@/types/types';

type FunctionResult = {
  data: any;
  error: unknown;
};

async function invokeVoiceFunction(
  functionName: 'short-speech-recognition' | 'text-translation' | 'tts-baidu',
  body: Record<string, unknown>,
): Promise<FunctionResult> {
  if (import.meta.env.DEV) {
    try {
      const response = await fetch(`/api/local/baidu/${functionName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail ?? data?.error ?? `HTTP ${response.status}`);
      }
      return { data, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }
  return supabase.functions.invoke(functionName, { body });
}

// ─── WAV 转换 ────────────────────────────────────────────────
// webm → 16kHz 单声道 16bit PCM WAV（百度 ASR 要求）
// 优先用 OfflineAudioContext 高质量重采样；若环境不支持则 fallback 到线性插值
async function convertToWav(arrayBuffer: ArrayBuffer): Promise<ArrayBuffer> {
  const TARGET_RATE = 16000;

  // 解码原始音频
  const decodeCtx = new AudioContext();
  const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  await decodeCtx.close();

  const sourceSampleRate = audioBuffer.sampleRate;
  const sourceLen = audioBuffer.length;
  const sourcePcm = audioBuffer.getChannelData(0);

  let pcm: Float32Array = sourcePcm;
  if (sourceSampleRate === TARGET_RATE) {
    pcm = sourcePcm;
  } else {
    // 优先用 OfflineAudioContext（质量更高），微信/旧 WebView 不支持时 fallback
    let offlineOk = false;
    try {
      const outLen = Math.ceil(sourceLen * TARGET_RATE / sourceSampleRate);
      const offlineCtx = new OfflineAudioContext(1, outLen, TARGET_RATE);
      const src = offlineCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(offlineCtx.destination);
      src.start(0);
      const rendered = await offlineCtx.startRendering();
      pcm = rendered.getChannelData(0);
      offlineOk = true;
    } catch {
      offlineOk = false;
    }
    if (!offlineOk) {
      // Fallback：线性插值重采样（兼容微信 WebView / 旧 iOS）
      const ratio = sourceSampleRate / TARGET_RATE;
      const outLen = Math.ceil(sourcePcm.length / ratio);
      const fallbackPcm = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, sourcePcm.length - 1);
        const frac = srcIdx - lo;
        fallbackPcm[i] = sourcePcm[lo] * (1 - frac) + sourcePcm[hi] * frac;
      }
      pcm = fallbackPcm;
    }
  }

  // 写 WAV 文件头 + 16bit PCM 数据
  const dataLen = pcm.length * 2;
  const wav = new ArrayBuffer(44 + dataLen);
  const v = new DataView(wav);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);               // PCM
  v.setUint16(22, 1, true);               // 单声道
  v.setUint32(24, TARGET_RATE, true);     // 采样率 16000
  v.setUint32(28, TARGET_RATE * 2, true); // byteRate
  v.setUint16(32, 2, true);              // blockAlign
  v.setUint16(34, 16, true);             // bitsPerSample
  w(36, 'data'); v.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return wav;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.clone === 'function') {
    try {
      const payload = await context.clone().json() as { error?: string; msg?: string; detail?: string };
      const detail = payload.error ?? payload.msg ?? payload.detail;
      if (detail?.includes('does not match token appId')) {
        return `${fallback}：语音服务仍指向旧项目，请重新部署当前源码中的 Edge Function`;
      }
      if (detail) return `${fallback}：${detail}`;
    } catch { /* 使用 SDK 错误信息 */ }
  }
  const message = error instanceof Error ? error.message : '';
  return `${fallback}：${message || '服务暂不可用'}`;
}

// ─── 语音识别（百度 ASR）────────────────────────────────────
// dev_pid 1537：普通话近场识别模型（百度当前标准版，支持标点）
export async function recognizeSpeech(webmBlob: Blob): Promise<string> {
  const arrayBuffer = await webmBlob.arrayBuffer();
  const wavBuffer = await convertToWav(arrayBuffer);
  const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
  const speechBase64 = await blobToBase64(wavBlob);
  const { data, error } = await invokeVoiceFunction('short-speech-recognition', {
    speech: speechBase64,
    len: wavBlob.size,
    format: 'wav',
    rate: 16000,
    cuid: 'web-guide-user',
    dev_pid: 1537,
  });
  if (error) throw new Error(await functionErrorMessage(error, '语音识别服务调用失败'));
  if (data?.err_no !== 0) throw new Error(`语音识别失败：${data?.err_msg ?? data?.err_no ?? '未知错误'}`);
  return data?.result?.[0] ?? '';
}

// ─── 翻译（百度翻译）────────────────────────────────────────
export async function translateText(text: string, from = 'zh', to = 'en'): Promise<string> {
  const { data, error } = await invokeVoiceFunction('text-translation', { q: text, from, to });
  if (error) { console.error('翻译失败:', error); return ''; }
  if (data?.error_code) { console.error(`翻译 API 错误 ${data.error_code}: ${data.error_msg}`); return ''; }
  const result = data?.result?.trans_result;
  if (Array.isArray(result) && result.length > 0) {
    return result.map((r: { dst: string }) => r.dst).join('\n');
  }
  return '';
}

// ─── 英文语音合成（百度短文本在线合成）──────────────────────
export async function generateEnglishSpeech(englishText: string): Promise<string> {
  if (!englishText.trim()) return '';
  const { data, error } = await invokeVoiceFunction('tts-baidu', { text: englishText });
  if (error) { console.error('英文语音合成失败:', error); return ''; }
  if (data?.error) { console.error('英文语音合成业务错误:', data.error); return ''; }
  return data?.audioUrl ?? '';
}

// ─── 上传音频原声到 Storage ──────────────────────────────────
export async function uploadAudio(roomId: string, blob: Blob): Promise<string> {
  const fileName = `${roomId}/${Date.now()}_audio.webm`;
  const { data, error } = await supabase.storage
    .from('audio')
    .upload(fileName, blob, { contentType: blob.type || 'audio/webm' });
  if (error) { console.error('上传音频失败:', error); return ''; }
  return supabase.storage.from('audio').getPublicUrl(data.path).data.publicUrl;
}

const localSubtitleKey = (roomId: string) => `shiguang-local-subtitles-${roomId}`;

export function readLocalSubtitles(roomId: string): Subtitle[] {
  try {
    const saved = sessionStorage.getItem(localSubtitleKey(roomId));
    return saved ? JSON.parse(saved) as Subtitle[] : [];
  } catch {
    return [];
  }
}

export function storeLocalSubtitle(subtitle: Subtitle) {
  const current = readLocalSubtitles(subtitle.room_id);
  const next = [...current.filter(item => item.id !== subtitle.id), subtitle]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-200);
  sessionStorage.setItem(localSubtitleKey(subtitle.room_id), JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('shiguang-local-subtitle', { detail: subtitle }));
}

function emitSubtitleChange(subtitle: Subtitle) {
  window.dispatchEvent(new CustomEvent('shiguang-local-subtitle', { detail: subtitle }));
}

type EnrichmentTracker = {
  pending: Set<Promise<void>>;
  failedCount: number;
};

const enrichmentTrackers = new Map<string, EnrichmentTracker>();

async function retryNonEmpty(
  task: () => Promise<string>,
  attempts: number,
  timeoutMs: number,
): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await Promise.race([
        task(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);
      if (value.trim()) return value;
    } catch {
      // 瞬时错误和超时统一进入有限重试；最终失败由调用方记录。
    }
    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, 300 * attempt));
    }
  }
  return '';
}

async function enrichSubtitle(inserted: Subtitle): Promise<boolean> {
  const contentEn = await retryNonEmpty(
    () => translateText(inserted.content_cn, 'zh', 'en'),
    3,
    8000,
  );
  if (!contentEn) return false;

  const englishAudioUrl = await retryNonEmpty(
    () => generateEnglishSpeech(contentEn),
    2,
    12000,
  );

  const { data, error: updateError } = await supabase
    .from('subtitles')
    .update({ content_en: contentEn, audio_url: englishAudioUrl })
    .eq('id', inserted.id)
    .select()
    .maybeSingle();
  if (updateError || !data) {
    console.error('英文字幕与语音更新失败:', updateError ?? '未更新到字幕行');
    return false;
  }
  emitSubtitleChange(data as Subtitle);
  return Boolean(englishAudioUrl);
}

function trackSubtitleEnrichment(inserted: Subtitle) {
  let tracker = enrichmentTrackers.get(inserted.room_id);
  if (!tracker) {
    tracker = { pending: new Set(), failedCount: 0 };
    enrichmentTrackers.set(inserted.room_id, tracker);
  }

  const task = enrichSubtitle(inserted)
    .then(success => {
      if (!success) tracker!.failedCount += 1;
    })
    .catch(error => {
      tracker!.failedCount += 1;
      console.error('英文翻译与语音合成任务失败:', error);
    })
    .finally(() => {
      tracker!.pending.delete(task);
    });
  tracker.pending.add(task);
}

/**
 * 等待指定房间所有已登记的翻译与英文 TTS 任务完成。
 * 每个上游调用都有有限超时和重试，因此不会无限挂起。
 */
export async function waitForSubtitleEnrichment(
  roomId: string,
): Promise<{ failedCount: number }> {
  const tracker = enrichmentTrackers.get(roomId);
  if (!tracker) return { failedCount: 0 };
  while (tracker.pending.size > 0) {
    await Promise.allSettled([...tracker.pending]);
  }
  enrichmentTrackers.delete(roomId);
  return { failedCount: tracker.failedCount };
}

// 浏览器原生语音识别可作为服务端 ASR 的优先兼容路径，识别结果仍写入同一字幕表。
export async function saveRecognizedSubtitle(roomId: string, contentCn: string): Promise<Subtitle | null> {
  if (!contentCn.trim()) return null;
  const { data, error } = await supabase
    .from('subtitles')
    .insert({ room_id: roomId, content_cn: contentCn.trim(), content_en: null, audio_url: '', chinese_audio_url: '' })
    .select()
    .maybeSingle();
  if (error || !data) throw new Error(`字幕写入失败：${error?.message ?? '未返回字幕数据'}`);
  const inserted = data as Subtitle;
  emitSubtitleChange(inserted);
  trackSubtitleEnrichment(inserted);
  return inserted;
}

// 流式识别与短语音回退共用的最终字幕落库入口。
// 演示房间仅写 sessionStorage；真实房间写 subtitles，并在后台翻译与合成英文语音。
export async function saveRecognizedText(roomId: string, contentCn: string): Promise<Subtitle | null> {
  const normalized = contentCn.trim();
  if (!normalized) return null;
  if (roomId !== 'demo-room') {
    return saveRecognizedSubtitle(roomId, normalized);
  }

  const subtitle: Subtitle = {
    id: crypto.randomUUID(),
    room_id: roomId,
    content_cn: normalized,
    content_en: null,
    audio_url: '',
    chinese_audio_url: '',
    created_at: new Date().toISOString(),
  };
  storeLocalSubtitle(subtitle);
  void (async () => {
    let contentEn = '';
    let audioUrl = '';
    try { contentEn = await translateText(subtitle.content_cn, 'zh', 'en'); } catch { /* 中文已展示 */ }
    if (contentEn) {
      try { audioUrl = await generateEnglishSpeech(contentEn); } catch { /* 英文字幕仍可展示 */ }
    }
    storeLocalSubtitle({ ...subtitle, content_en: contentEn || null, audio_url: audioUrl });
  })();
  return subtitle;
}

// 演示房间不写数据库，但使用与真实房间相同的服务端 ASR，识别结果保存在当前会话。
export async function processDemoAudioChunk(roomId: string, chunkBlob: Blob): Promise<Subtitle | null> {
  const contentCn = await recognizeSpeech(chunkBlob);
  return saveRecognizedText(roomId, contentCn);
}

// ─── 处理单段音频（完整流水线）───────────────────────────────
// 修复：解除 recognizeSpeech 与 uploadAudio 的 Promise.all 绑定。
// 新流程：
//   1. recognizeSpeech（有超时）→ 识别成功立即 INSERT subtitles（content_cn 已有，chinese_audio_url 先为空）
//   2. uploadAudio 在 INSERT 后后台异步执行 → 成功后 UPDATE 同一条 subtitle.chinese_audio_url
//   3. enrichSubtitle（英文翻译 + TTS）继续后台运行，不阻塞中文字幕
// 这样即使 uploadAudio 慢或失败，中文字幕也能立即出现。
export async function processAudioChunk(
  roomId: string,
  chunkBlob: Blob
): Promise<Subtitle | null> {
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

  console.log(`[ASR] ASR 请求开始 | roomId=${roomId} size=${chunkBlob.size}`);

  // 步骤 1：语音识别（独立超时 15s，不等待音频上传）
  let contentCn = '';
  try {
    contentCn = await withTimeout(recognizeSpeech(chunkBlob), 15000);
    console.log(`[ASR] ASR 返回 | roomId=${roomId} contentCn="${contentCn}"`);
  } catch (err) {
    const phase = err instanceof Error && err.message === 'timeout' ? '识别超时' : '识别失败';
    console.error(`[ASR] 中文字幕写入失败 | roomId=${roomId} phase=${phase}`, err);
    throw err instanceof Error ? err : new Error('语音识别失败');
  }
  if (!contentCn.trim()) return null;

  // 步骤 2：INSERT subtitles（chinese_audio_url 先为空，后台上传后再 UPDATE）
  const { data, error } = await supabase
    .from('subtitles')
    .insert({ room_id: roomId, content_cn: contentCn.trim(), content_en: null, audio_url: '', chinese_audio_url: '' })
    .select()
    .maybeSingle();
  if (error || !data) {
    console.error(`[ASR] 中文字幕写入失败 | roomId=${roomId} phase=db_insert`, error);
    throw new Error(`字幕写入失败：${error?.message ?? '未返回字幕数据'}`);
  }

  const inserted = data as Subtitle;
  console.log(`[ASR] 中文字幕写入成功 | id=${inserted.id} roomId=${roomId} content_cn="${contentCn.trim()}"`);

  // 步骤 3：后台上传原始音频，成功后 UPDATE chinese_audio_url（失败不影响字幕）
  void (async () => {
    try {
      const chineseAudioUrl = await withTimeout(uploadAudio(roomId, chunkBlob), 20000);
      if (chineseAudioUrl) {
        const { error: upErr } = await supabase
          .from('subtitles')
          .update({ chinese_audio_url: chineseAudioUrl })
          .eq('id', inserted.id);
        if (upErr) console.warn(`[ASR] chinese_audio_url 更新失败 | id=${inserted.id}`, upErr);
      }
    } catch (uploadErr) {
      console.warn(`[ASR] 音频上传失败（不影响字幕）| roomId=${roomId}`, uploadErr);
    }
  })();

  emitSubtitleChange(inserted);
  // 步骤 4：后台英文翻译 + TTS；结束房间时会等待此登记任务完成。
  trackSubtitleEnrichment(inserted);
  return inserted;
}

// 统一错误处理：防止 Realtime 服务端连接数耗尽时抛出未捕获异常
type RealtimeChannel = ReturnType<typeof supabase.channel>;
type RealtimeStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | string;
export type SubtitleChangeSource =
  | 'insert'
  | 'update'
  | 'delete'
  | 'local'
  | 'poll-snapshot'
  | 'poll-insert'
  | 'poll-update';
function logRealtimeError(source: string, status: RealtimeStatus, err?: Error | null) {
  if (status === 'SUBSCRIBED') return;
  const msg = err?.message ?? '';
  if (msg.includes("DatabaseLackOfConnections") || msg.includes("can't accept more connections")) {
    console.warn(`[Realtime] ${source} 订阅受限：数据库连接数已满，启动轮询降级`);
  } else if (err) {
    console.error(`[Realtime] ${source} 订阅失败:`, status, err);
  }
}

/**
 * subscribeWithFallback — 订阅已配好监听器的 channel，连接异常时自动降级为 3 秒增量轮询。
 *
 * 去重策略（同时修复 UPDATE 漏推问题）：
 *   维护 id → fingerprint Map，fingerprint = `${content_en ?? ''}|${audio_url}`。
 *   每轮轮询：id 首次出现 → 回调 onSubtitle；已见 id 但 fingerprint 变化（英文/音频已更新）→ 也回调 onSubtitle。
 *   这样同一条字幕先 INSERT 中文、后 UPDATE 写入 content_en/audio_url 时，两次都会触发回调。
 *
 * @param channel     已调用 .on() 配置好的 channel（此函数内部调用 .subscribe()，外部勿重复调用）
 * @param source      日志标识字符串
 * @param roomId      字幕表所属房间 ID（轮询用）
 * @param onStatus    'ok'（Realtime 正常）/ 'degraded'（轮询中）
 * @param onSubtitle  新字幕 / 内容更新回调
 * @returns           { unsubscribe() } — 页面卸载时调用
 */
export function subscribeWithFallback(
  channel: RealtimeChannel,
  source: string,
  roomId: string,
  onStatus: (s: 'ok' | 'degraded') => void,
  onSubtitle: (s: Subtitle, source: SubtitleChangeSource) => void,
  /** 可选：channel 成功 SUBSCRIBED 后的回调，用于外部门控（如 card_pushes 推送通知） */
  onSubscribed?: () => void
): { unsubscribe: () => void } {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;
  let hasPolled = false;

  // id → fingerprint，用于检测同一条字幕的任何内容更新（中文修正/英文/音频/翻译状态）
  const fingerprintMap = new Map<string, string>();

  const makeFingerprint = (s: Subtitle) =>
    `${s.content_cn}|${s.content_en ?? ''}|${s.audio_url ?? ''}|${s.translation_status ?? ''}`;

  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  const runPoll = async () => {
    if (destroyed) return;
    try {
      // 查最近 100 条（desc），内存中升序排列后逐条 fingerprint 合并回调
      // 避免房间超过 100 条后 asc+limit(100) 永远只拿最早的记录
      const { data } = await supabase
        .from('subtitles')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (!data) return;
      // 内存升序：优先 sequence，其次 created_at
      const rows = (data as Subtitle[]).sort((a, b) => {
        if (a.sequence != null && b.sequence != null) return a.sequence - b.sequence;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
      for (const row of rows) {
        const fp = makeFingerprint(row);
        const previous = fingerprintMap.get(row.id);
        if (previous === undefined || previous !== fp) {
          fingerprintMap.set(row.id, fp);
          onSubtitle(
            row,
            !hasPolled
              ? 'poll-snapshot'
              : previous === undefined
                ? 'poll-insert'
                : 'poll-update',
          );
        }
      }
      hasPolled = true;
    } catch { /* 网络抖动，下次重试 */ }
  };

  const startPoll = () => {
    if (pollTimer || destroyed) return;
    onStatus('degraded');
    // 首次降级立即拉取一次，不空等 3 秒
    void runPoll();
    pollTimer = setInterval(runPoll, 3000);
  };

  channel.subscribe((status: string, err?: Error | null) => {
    if (destroyed) return;
    if (status === 'SUBSCRIBED') {
      stopPoll();
      onStatus('ok');
      onSubscribed?.();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      logRealtimeError(source, status, err ?? null);
      startPoll();
    }
  });

  return {
    unsubscribe() {
      destroyed = true;
      stopPoll();
      channel.unsubscribe();
    },
  };
}

// 将字幕监听挂载到已有 channel，用于合并同一页面的多个 Realtime 订阅，减少连接数
export function attachSubtitleListener(
  channel: RealtimeChannel,
  roomId: string,
  onChange: (s: Subtitle, source: SubtitleChangeSource) => void
) {
  channel.on('postgres_changes',
    { event: '*', schema: 'public', table: 'subtitles', filter: `room_id=eq.${roomId}` },
    (payload) => {
      if (payload.eventType === 'DELETE') return;
      onChange(
        payload.new as Subtitle,
        payload.eventType === 'INSERT' ? 'insert' : 'update',
      );
    });

  const onLocal = (event: Event) => {
    const subtitle = (event as CustomEvent<Subtitle>).detail;
    if (subtitle?.room_id === roomId) onChange(subtitle, 'local');
  };
  window.addEventListener('shiguang-local-subtitle', onLocal);

  return {
    unsubscribe() {
      window.removeEventListener('shiguang-local-subtitle', onLocal);
    },
  };
}

// ─── 订阅字幕实时推送（独立 channel 版，适用于仅需要字幕监听的页面）───────────────────────────────────────
export function subscribeSubtitles(roomId: string, onInsert: (s: Subtitle) => void) {
  const channel = supabase
    .channel(`subtitles-${roomId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'subtitles', filter: `room_id=eq.${roomId}` },
      (payload) => onInsert(payload.new as Subtitle))
    .subscribe((status, err) => logRealtimeError(`subtitles-${roomId}`, status, err));

  const onLocal = (event: Event) => {
    const subtitle = (event as CustomEvent<Subtitle>).detail;
    if (subtitle?.room_id === roomId) onInsert(subtitle);
  };
  window.addEventListener('shiguang-local-subtitle', onLocal);
  return {
    unsubscribe() {
      window.removeEventListener('shiguang-local-subtitle', onLocal);
      // 修复：必须 removeChannel 才能从 SDK 连接池释放，仅 unsubscribe 会泄漏连接
      supabase.removeChannel(channel);
    },
  };
}

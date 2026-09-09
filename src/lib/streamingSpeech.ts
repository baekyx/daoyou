export type StreamingSpeechResult = {
  text: string;
  startTime?: number;
  endTime?: number;
};

export type StreamingSpeechCallbacks = {
  onPartial: (result: StreamingSpeechResult) => void;
  onFinal: (result: StreamingSpeechResult) => void | Promise<void>;
  onWarning?: (message: string, errorCode?: number) => void;
  onError: (message: string) => void;
};

export type StreamingSpeechSession = {
  stop: () => Promise<void>;
  cancel: () => void;
};

type BaiduRealtimeMessage = {
  type?: "MID_TEXT" | "FIN_TEXT" | "HEARTBEAT" | "LOCAL_ERROR";
  result?: string;
  err_no?: number;
  err_msg?: string;
  start_time?: number;
  end_time?: number;
};

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_BYTES = 5_120; // 百度建议的 160ms PCM 帧
const MIN_FINAL_FRAME_BYTES = 640; // 20ms，百度允许的最小帧
const SESSION_ROTATION_MS = 130_000; // 避开 Supabase Edge Function 150s wall-clock 上限
const ROTATION_CLOSE_GRACE_MS = 3_000;
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_DELAYS_MS = [300, 800, 1_600, 3_000] as const;
const MAX_BUFFER_BYTES = TARGET_SAMPLE_RATE * 2 * 6; // 断线轮换期间最多保留最近 6 秒 PCM

type ManagedSocket = {
  socket: WebSocket;
  generation: number;
  acceptingAudio: boolean;
  closeIntent: "none" | "rotate" | "terminal";
  closed: Promise<void>;
  resolveClosed: () => void;
};

function resampleTo16Khz(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === TARGET_SAMPLE_RATE) return input.slice();
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(lower + 1, input.length - 1);
    const fraction = sourceIndex - lower;
    output[i] = input[lower] * (1 - fraction) + input[upper] * fraction;
  }
  return output;
}

function floatToPcm16(samples: Float32Array): Uint8Array {
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return pcm;
}

function websocketUrl(): string {
  const configured = String(import.meta.env.VITE_STREAMING_ASR_WS_URL ?? "").trim();
  if (configured) return configured;
  if (!import.meta.env.DEV) {
    throw new Error("生产环境尚未配置流式识别 WebSocket 网关");
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/local/baidu/realtime-asr`;
}

export async function startStreamingSpeech(
  stream: MediaStream,
  callbacks: StreamingSpeechCallbacks,
): Promise<StreamingSpeechSession> {
  const url = websocketUrl();
  let pendingPcm = new Uint8Array(0);
  let captureClosed = false;
  let terminalRequested = false;
  let fatalErrorReported = false;
  let sessionReady = false;
  let generation = 0;
  let currentSocket: ManagedSocket | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: number | null = null;
  let rotationTimer: number | null = null;
  let reconnectInFlight: Promise<void> | null = null;
  let closeCapture = () => {};

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearRotationTimer = () => {
    if (rotationTimer !== null) {
      window.clearTimeout(rotationTimer);
      rotationTimer = null;
    }
  };

  const appendPcm = (pcm: Uint8Array) => {
    const merged = new Uint8Array(pendingPcm.byteLength + pcm.byteLength);
    merged.set(pendingPcm);
    merged.set(pcm, pendingPcm.byteLength);
    pendingPcm = merged.byteLength > MAX_BUFFER_BYTES
      ? merged.slice(merged.byteLength - MAX_BUFFER_BYTES)
      : merged;
  };

  const sendPendingFrames = (managed: ManagedSocket, flush = false) => {
    const { socket } = managed;
    if (socket.readyState !== WebSocket.OPEN) return;
    while (pendingPcm.byteLength >= FRAME_BYTES) {
      socket.send(pendingPcm.slice(0, FRAME_BYTES));
      pendingPcm = pendingPcm.slice(FRAME_BYTES);
    }
    if (flush && pendingPcm.byteLength >= MIN_FINAL_FRAME_BYTES) {
      socket.send(pendingPcm);
      pendingPcm = new Uint8Array(0);
    }
  };

  const reportFatalError = (message: string) => {
    if (fatalErrorReported || terminalRequested) return;
    fatalErrorReported = true;
    terminalRequested = true;
    clearReconnectTimer();
    clearRotationTimer();
    closeCapture();
    const managed = currentSocket;
    if (managed?.socket.readyState === WebSocket.OPEN) {
      managed.closeIntent = "terminal";
      managed.socket.send(JSON.stringify({ type: "CANCEL" }));
      managed.socket.close();
    }
    callbacks.onError(message);
  };

  const handleMessage = (event: MessageEvent) => {
    let message: BaiduRealtimeMessage;
    try {
      message = JSON.parse(String(event.data)) as BaiduRealtimeMessage;
    } catch {
      reportFatalError("百度实时识别返回了无法解析的数据");
      return;
    }
    if (message.type === "HEARTBEAT") return;
    const errorCode = Number(message.err_no ?? 0);
    if (message.type === "LOCAL_ERROR") {
      reportFatalError(message.err_msg || "本地流式识别网关异常");
      return;
    }
    if (errorCode !== 0) {
      // 百度会把单句识别失败（常见 -3005: asr server not find）作为 FIN_TEXT 返回，
      // 这种错误只影响当前句，后续句子仍可继续识别，不能关闭整条会话。
      if (message.type === "FIN_TEXT" && errorCode === -3005) {
        const warning = message.err_msg || "当前句识别失败，继续等待下一句";
        console.warn(`[Streaming ASR] 可恢复的单句错误 ${errorCode}: ${warning}`);
        callbacks.onWarning?.(warning, errorCode);
        return;
      }
      reportFatalError(message.err_msg || `百度实时识别错误 ${errorCode}`);
      return;
    }

    const result = {
      text: String(message.result ?? "").trim(),
      startTime: message.start_time,
      endTime: message.end_time,
    };
    if (!result.text) return;
    if (message.type === "MID_TEXT") callbacks.onPartial(result);
    if (message.type === "FIN_TEXT") void callbacks.onFinal(result);
  };

  const rotateSocket = async (managed: ManagedSocket) => {
    if (
      terminalRequested
      || currentSocket !== managed
      || managed.socket.readyState !== WebSocket.OPEN
    ) return;

    console.info(`[Streaming ASR] 主动轮换第 ${managed.generation} 个识别会话`);
    clearRotationTimer();
    managed.closeIntent = "rotate";
    managed.acceptingAudio = false;
    sendPendingFrames(managed, true);
    managed.socket.send(JSON.stringify({ type: "FINISH" }));

    await Promise.race([
      managed.closed,
      new Promise<void>(resolve => window.setTimeout(resolve, ROTATION_CLOSE_GRACE_MS)),
    ]);
    if (managed.socket.readyState === WebSocket.OPEN) {
      managed.socket.close(1000, "ASR session rotation");
    }
  };

  const scheduleRotation = (managed: ManagedSocket) => {
    clearRotationTimer();
    rotationTimer = window.setTimeout(() => {
      void rotateSocket(managed);
    }, SESSION_ROTATION_MS);
  };

  let scheduleReconnect: (reason: string, immediate?: boolean) => void;

  const openSocket = () => new Promise<ManagedSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const socketGeneration = ++generation;
    let opened = false;
    let settled = false;
    let resolveClosed = () => {};
    const closed = new Promise<void>(closedResolve => {
      resolveClosed = closedResolve;
    });
    const managed: ManagedSocket = {
      socket,
      generation: socketGeneration,
      acceptingAudio: false,
      closeIntent: "none",
      closed,
      resolveClosed,
    };
    const connectTimer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      managed.closeIntent = "terminal";
      socket.close();
      reject(new Error("连接百度实时语音识别超时"));
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      window.clearTimeout(connectTimer);
      if (terminalRequested) {
        managed.closeIntent = "terminal";
        socket.close();
        if (!settled) {
          settled = true;
          reject(new Error("流式识别会话已结束"));
        }
        return;
      }
      opened = true;
      settled = true;
      managed.acceptingAudio = true;
      currentSocket = managed;
      reconnectAttempts = 0;
      scheduleRotation(managed);
      sendPendingFrames(managed);
      console.info(`[Streaming ASR] 第 ${socketGeneration} 个识别会话已连接`);
      resolve(managed);
    };
    socket.onmessage = handleMessage;
    socket.onerror = () => {
      if (!opened && !settled) {
        window.clearTimeout(connectTimer);
        settled = true;
        reject(new Error("无法连接百度实时语音识别"));
      }
    };
    socket.onclose = () => {
      window.clearTimeout(connectTimer);
      managed.acceptingAudio = false;
      managed.resolveClosed();
      if (currentSocket === managed) {
        currentSocket = null;
        clearRotationTimer();
      }
      if (!opened && !settled) {
        settled = true;
        reject(new Error("百度实时语音识别连接在建立前中断"));
        return;
      }
      if (!terminalRequested && sessionReady) {
        scheduleReconnect(
          managed.closeIntent === "rotate" ? "会话轮换" : "连接意外中断",
          managed.closeIntent === "rotate",
        );
      }
    };
  });

  const reconnect = async (reason: string) => {
    if (terminalRequested || currentSocket?.socket.readyState === WebSocket.OPEN) return;
    try {
      await openSocket();
      console.info(`[Streaming ASR] ${reason}后已恢复`);
    } catch (error) {
      if (terminalRequested) return;
      reconnectAttempts += 1;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        reportFatalError(
          error instanceof Error ? error.message : "百度实时语音识别重连失败",
        );
        return;
      }
      scheduleReconnect("重连失败");
    }
  };

  scheduleReconnect = (reason, immediate = false) => {
    if (terminalRequested || reconnectTimer !== null || reconnectInFlight) return;
    const delay = immediate
      ? 0
      : RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      reconnectInFlight = reconnect(reason).finally(() => {
        reconnectInFlight = null;
      });
    }, delay);
  };

  let initialSocket: ManagedSocket;
  try {
    initialSocket = await openSocket();
  } catch (error) {
    throw error instanceof Error ? error : new Error("无法连接百度实时语音识别");
  }

  let audioContext: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let processor: ScriptProcessorNode;
  let mutedOutput: GainNode;
  try {
    audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    await audioContext.resume();
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(2048, 1, 1);
    mutedOutput = audioContext.createGain();
    mutedOutput.gain.value = 0;
    source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(audioContext.destination);
  } catch (error) {
    terminalRequested = true;
    clearRotationTimer();
    initialSocket.closeIntent = "terminal";
    if (initialSocket.socket.readyState === WebSocket.OPEN) {
      initialSocket.socket.send(JSON.stringify({ type: "CANCEL" }));
      initialSocket.socket.close();
    }
    throw error;
  }

  closeCapture = () => {
    if (captureClosed) return;
    captureClosed = true;
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    mutedOutput.disconnect();
    void audioContext.close();
  };

  processor.onaudioprocess = (event) => {
    if (captureClosed) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = floatToPcm16(resampleTo16Khz(input, audioContext.sampleRate));
    appendPcm(pcm);
    const managed = currentSocket;
    if (managed?.acceptingAudio && managed.socket.readyState === WebSocket.OPEN) {
      sendPendingFrames(managed);
    }
  };
  sessionReady = true;
  // 初始化 AudioContext 的极短窗口内如果连接已经关闭，也要进入正常重连流程。
  if (initialSocket.socket.readyState !== WebSocket.OPEN) {
    scheduleReconnect("初始化期间连接中断", true);
  }

  return {
    async stop() {
      terminalRequested = true;
      clearReconnectTimer();
      clearRotationTimer();
      closeCapture();
      const managed = currentSocket;
      if (managed?.socket.readyState === WebSocket.OPEN) {
        managed.closeIntent = "terminal";
        managed.acceptingAudio = false;
        sendPendingFrames(managed, true);
        managed.socket.send(JSON.stringify({ type: "FINISH" }));
        await Promise.race([
          managed.closed,
          new Promise<void>(resolve => window.setTimeout(resolve, 5_000)),
        ]);
        if (managed.socket.readyState === WebSocket.OPEN) managed.socket.close();
      }
    },
    cancel() {
      terminalRequested = true;
      clearReconnectTimer();
      clearRotationTimer();
      closeCapture();
      const managed = currentSocket;
      if (managed?.socket.readyState === WebSocket.OPEN) {
        managed.closeIntent = "terminal";
        managed.acceptingAudio = false;
        managed.socket.send(JSON.stringify({ type: "CANCEL" }));
        managed.socket.close();
      }
    },
  };
}

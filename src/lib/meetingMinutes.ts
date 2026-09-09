import type { Room, Subtitle } from '@/types/types';

export interface MeetingMinutes {
  roomId: string;
  roomName: string;
  title: string;
  keywords: string[];
  overview: string;
  keyPoints: string[];
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  subtitleCount: number;
  generatedAt: string;
}

const STORAGE_KEY = 'shiguang-meeting-minutes-v1';
const CHANGE_EVENT = 'shiguang-meeting-minutes-change';

function readStore(): Record<string, MeetingMinutes> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?；;])/)
    .map(item => item.trim())
    .filter(item => item.length >= 6);
}

function trimText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).replace(/[，、\s]+$/, '')}…` : text;
}

const LOW_VALUE_TEXT = /^(你好|您好|喂|嗯+|啊+|哦+|对+|是的|有声音吗|没有声音|现在还没有|谢谢|好的)[。！？!?，,\s]*$/;

function meaningfulSentences(subtitle: Subtitle): string[] {
  return splitSentences(subtitle.content_cn ?? '')
    .map(text => text.replace(/^(然后|就是|这个|那个|那么|其实|我们可以说)[，,\s]*/g, '').trim())
    .filter(text => text.length >= 8 && !LOW_VALUE_TEXT.test(text));
}

function sentenceScore(text: string): number {
  const signalWords = text.match(/(位于|始建|建于|历史|文化|建筑|特点|主要|因为|因此|代表|保护|展示|采用|形成|重要|需要|注意)/g)?.length ?? 0;
  const fillerPenalty = text.match(/(就是|然后|这个|那个|我觉得|可能|是不是|对对对)/g)?.length ?? 0;
  return Math.min(text.length, 72) + signalWords * 18 - fillerPenalty * 10;
}

const DOMAIN_KEYWORDS = [
  '历史', '文化', '建筑', '文物', '宫殿', '景区', '景点', '博物馆', '展览',
  '设计', '结构', '材料', '工艺', '艺术', '朝代', '皇帝', '故事', '传说',
  '保护', '修缮', '参观', '位置', '功能', '特色', '园林', '城墙', '故宫',
  '交通', '服务', '安全', '路线', '体验', '遗址', '收藏', '价值', '意义',
] as const;

const KEYWORD_STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '就是', '然后', '现在', '今天',
  '这里', '那里', '时候', '可以', '一个', '一些', '什么', '怎么', '因为',
  '所以', '但是', '还是', '已经', '没有', '非常', '比较', '觉得', '进行',
  '的话', '一下', '其实', '可能', '看到', '知道', '需要', '这样', '这种',
]);

function extractKeywords(text: string, limit = 5): string[] {
  const scores = new Map<string, number>();
  DOMAIN_KEYWORDS.forEach(keyword => {
    const count = text.split(keyword).length - 1;
    if (count > 0) scores.set(keyword, count * 20 + keyword.length);
  });

  const chunks = text.match(/[\u3400-\u9fff]{2,12}/g) ?? [];
  chunks.forEach(chunk => {
    for (const size of [4, 3, 2]) {
      for (let index = 0; index <= chunk.length - size; index += 1) {
        const word = chunk.slice(index, index + size);
        if (KEYWORD_STOPWORDS.has(word) || [...KEYWORD_STOPWORDS].some(stop => word.includes(stop))) continue;
        scores.set(word, (scores.get(word) ?? 0) + size);
      }
    }
  });

  const selected: string[] = [];
  [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .forEach(([word]) => {
      if (selected.length >= limit) return;
      if (selected.some(existing => existing.includes(word) || word.includes(existing))) return;
      selected.push(word);
    });
  return selected;
}

export function generateMeetingMinutes(room: Room, subtitles: Subtitle[]): MeetingMinutes {
  const ordered = [...subtitles].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const sentences = ordered.flatMap(meaningfulSentences);
  const unique = Array.from(new Set(sentences));
  const keyPoints = unique
    .map((text, index) => ({ text, index, score: sentenceScore(text) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .sort((a, b) => a.index - b.index)
    .map(item => trimText(item.text, 76));

  const overviewPoints = unique
    .map((text, index) => ({ text, index, score: sentenceScore(text) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map(item => trimText(item.text, 60));
  const overviewSource = overviewPoints.join('；');

  const firstTime = ordered.length > 0 ? new Date(ordered[0].created_at).getTime() : Date.now();
  const lastTime = ordered.length > 0 ? new Date(ordered[ordered.length - 1].created_at).getTime() : firstTime;
  const globalKeywords = extractKeywords(
    ordered.map(item => item.content_cn ?? '').join('。'),
    8,
  );

  return {
    roomId: room.id,
    roomName: room.name,
    title: `${room.name}讲解纪要`,
    keywords: globalKeywords.length > 0 ? globalKeywords : ['讲解主题'],
    overview: overviewSource
      ? `本次讲解主要围绕：${trimText(overviewSource, 190)}。`
      : '本次讲解没有可用于生成纪要的中文字幕。',
    keyPoints: keyPoints.length > 0 ? keyPoints : ['本次讲解暂无可提炼的关键内容。'],
    startedAt: room.started_at ?? ordered[0]?.created_at ?? null,
    endedAt: room.ended_at ?? ordered[ordered.length - 1]?.created_at ?? null,
    durationSeconds: room.actual_duration != null && room.actual_duration > 0
      ? room.actual_duration * 60
      : Math.max(0, Math.floor((lastTime - firstTime) / 1000)),
    subtitleCount: ordered.length,
    generatedAt: new Date().toISOString(),
  };
}

export function saveMeetingMinutes(minutes: MeetingMinutes): void {
  const store = readStore();
  store[minutes.roomId] = minutes;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: minutes.roomId }));
}

export function readMeetingMinutes(roomId: string): MeetingMinutes | null {
  return readStore()[roomId] ?? null;
}

export function hasMeetingMinutes(roomId: string): boolean {
  return Boolean(readMeetingMinutes(roomId));
}

export function subscribeMeetingMinutes(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

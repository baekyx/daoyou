// ===== 枚举 =====
export type UserRole = "guide" | "tourist" | "photographer";
export type RoomStatus = "draft" | "ready" | "pending" | "live" | "paused" | "ended" | "archived";
export type LanguageMode = "cn" | "en" | "bilingual";
export type TranslationStatus = "done" | "translating" | "failed" | "none";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type UploadItemStatus = "pending" | "uploading" | "done" | "failed";

// ===== 数据库实体 =====
export interface Profile {
  id: string;
  username: string;
  nickname: string | null;
  avatar_url: string | null;
  phone: string | null;
  role: UserRole;
  gender: 'male' | 'female' | null;
  default_language?: LanguageMode;
  created_at: string;
  updated_at: string;
}

export interface Room {
  id: string;
  room_number: string;
  /** A2 预置：password 仅旧前端路径使用；新代码不得读取此字段 */
  password?: string;
  name: string;
  cover_url: string | null;
  guide_id: string;
  status: RoomStatus;
  discoverable: boolean;
  estimated_duration: number | null;
  actual_duration: number | null;
  online_count: number;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  // joined from profiles
  guide?: Pick<Profile, "id" | "username" | "nickname" | "avatar_url">;
}

export interface Membership {
  id: string;
  room_id: string;
  user_id: string;
  role: UserRole;
  approval_status: ApprovalStatus;
  rejection_reason?: string | null;
  joined_at: string;
  left_at: string | null;
  profile?: Pick<Profile, "id" | "username" | "nickname" | "avatar_url" | "role">;
}

/** check_room_access RPC 返回结构 */
export interface RoomAccessResult {
  authorized: boolean;
  /** 'pending' | 'live' | 'ended' | 'archived' | null */
  room_status: string | null;
  /** 'authorized' | 'no_access' | 'room_not_active' | 'room_not_found' | 'not_authenticated' */
  reason: string;
}

export interface RoomMember {
  id: string;
  room_id: string;
  user_id: string;
  role: UserRole;
  joined_at: string;
  /** v366: 首次正确输密码时写入；有效授权标志 */
  access_granted_at?: string | null;
  /** v366: 导游移出时写入；已撤销则不能免密进入 */
  access_revoked_at?: string | null;
  left_at: string | null;
  profile?: Pick<Profile, "id" | "username" | "nickname" | "avatar_url">;
}

export interface LiveSession {
  id: string;
  room_id: string;
  status: 'active' | 'paused' | 'ended';
  started_at: string;
  ended_at: string | null;
  duration: number | null;
  last_sequence: number;
}

export interface Subtitle {
  id: string;
  room_id: string;
  sequence?: number;
  content_cn: string;
  content_en: string | null;
  translation_status?: TranslationStatus;
  audio_url: string;
  chinese_audio_url: string;
  created_at: string;
}

export interface KnowledgeCard {
  id: string;
  title_cn: string;
  title_en: string | null;
  desc_cn: string;
  desc_en: string | null;
  category: string;
  image_url: string | null;
  era: string | null;
  location: string | null;
  status: 'draft' | 'published';
  created_by: string;
  created_at: string;
  /** 软删除时间戳；null 表示未删除 */
  deleted_at: string | null;
}

export interface Question {
  id: string;
  room_id: string;
  user_id: string;
  content: string;
  translated_text?: string | null;
  original_language?: 'zh' | 'en';
  is_answered: boolean;
  created_at: string;
  profile?: Pick<Profile, "id" | "username" | "nickname">;
}

/** 弹幕记录 */
export interface Barrage {
  id: string;
  room_id: string;
  user_id: string;
  content: string;
  created_at: string;
  profile?: Pick<Profile, "id" | "username" | "nickname">;
}

export interface Card {
  id: string;
  title_cn: string;
  title_en: string | null;
  content_cn: string;
  content_en: string | null;
  category: string;
  tags: string[];
  image_url: string | null;
  created_by: string;
  created_at: string;
}

/** 房间卡片关联记录（只存关联关系，内容从 knowledge_cards 实时读取） */
export interface RoomCard {
  id: string;
  room_id: string;
  source_card_id: string;
  imported_by: string;
  imported_at: string;
  /** 联查出的原卡最新内容（select 时带上 knowledge_card:knowledge_cards(*) 即可） */
  knowledge_card?: KnowledgeCard;
}

export interface CardPush {
  id: string;
  room_id: string;
  /** 兼容旧流程（指向 cards 表）；新流程为 null */
  card_id: string | null;
  /** 中间层兼容（指向 room_cards）；新流程不再写入 */
  room_card_id: string | null;
  /** Task2 新流程：直接指向 knowledge_cards.id */
  kc_card_id: string | null;
  /** 推送顺序 */
  sequence: number | null;
  pushed_by: string;
  pushed_at: string;
  /** 新流程联查 KC 内容 */
  knowledge_card?: KnowledgeCard;
  /** 中间层联查（保留兼容） */
  room_card?: RoomCard;
  /** 旧流程联查（保留兼容） */
  card?: Card;
}

export interface Feedback {
  id: string;
  user_id: string;
  role: string;
  category: string;
  content: string;
  contact: string | null;
  status: string;
  created_at: string;
}

export interface Photo {
  id: string;
  room_id: string;
  photographer_id: string;
  url: string;
  taken_at: string | null;
  uploaded_at: string;
  delete_status?: 'none' | 'requested' | 'approved';
  delete_reason?: string | null;
  is_favorite?: boolean;
  photographer?: Pick<Profile, "id" | "username" | "nickname">;
}

export interface UploadQueueItem {
  id: string;
  file: File;
  fileName: string;
  progress: number;
  status: UploadItemStatus;
  errorMessage?: string;
  url?: string;
}

export interface Favorite {
  id: string;
  user_id: string;
  target_type: "subtitle" | "photo" | "card";
  target_id: string;
  created_at: string;
}

// ===== 字幕偏好 =====
export interface SubtitlePrefs {
  showCn: boolean;
  showEn: boolean;
  mode: LanguageMode;
  fontSize: "small" | "medium" | "large";
}

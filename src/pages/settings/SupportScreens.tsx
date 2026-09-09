import { useEffect, useMemo, useState } from 'react';
import {
  Bell, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronUp,
  HelpCircle, Radio, Send,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { fetchGuideRooms } from '@/api/rooms';
import { fetchMyJoinedRooms } from '@/api/roomActivity';
import { insertFeedback } from '@/api/feedbacks';
import { hasMeetingMinutes } from '@/lib/meetingMinutes';
import type { Room } from '@/types/types';

interface Props { go: (id: string) => void }

function homeForRole(role?: string) {
  if (role === 'guide') return 'my';
  if (role === 'photographer') return 'photographer-my';
  return 'tourist-my';
}

const READ_KEY = 'shiguang-read-notifications-v1';

function formatNoticeTime(value?: string | null) {
  if (!value) return '时间待同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间待同步';
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function NotificationsScreen({ go }: Props) {
  const { user, profile, setCurrentRoom } = useAuth();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [readIds, setReadIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(READ_KEY) ?? '[]'); } catch { return []; }
  });

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const request = profile?.role === 'guide'
      ? fetchGuideRooms(user.id)
      : fetchMyJoinedRooms(user.id);
    request.then(data => {
      setRooms(data);
      setLoading(false);
    });
  }, [profile?.role, user]);

  const notices = useMemo(() => rooms
    .filter(room => room.status === 'live' || room.status === 'paused' || room.status === 'ended' || room.status === 'archived')
    .map(room => ({
      id: `${room.id}-${room.status}-${hasMeetingMinutes(room.id) ? 'minutes' : 'plain'}`,
      room,
      title: room.status === 'live' || room.status === 'paused'
        ? `“${room.name}”正在讲解`
        : hasMeetingMinutes(room.id)
          ? `“${room.name}”会议纪要已生成`
          : `“${room.name}”讲解已结束`,
      detail: room.status === 'live' || room.status === 'paused'
        ? (profile?.role === 'guide' ? '点击继续讲解' : '点击继续收听')
        : (profile?.role === 'guide' ? '点击查看完整字幕与会议纪要' : '点击查看字幕回放'),
      at: room.ended_at ?? room.started_at ?? room.created_at,
    }))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()), [profile?.role, rooms]);

  const markRead = (id: string) => {
    setReadIds(current => {
      const next = current.includes(id) ? current : [...current, id];
      localStorage.setItem(READ_KEY, JSON.stringify(next));
      return next;
    });
  };

  const openNotice = (notice: typeof notices[number]) => {
    markRead(notice.id);
    setCurrentRoom(notice.room);
    if (notice.room.status === 'live' || notice.room.status === 'paused') {
      go(profile?.role === 'guide' ? 'guide-live' : 'listening');
    } else {
      go(profile?.role === 'guide' ? 'record-detail' : 'subtitle-history');
    }
  };

  const markAllRead = () => {
    const next = notices.map(item => item.id);
    localStorage.setItem(READ_KEY, JSON.stringify(next));
    setReadIds(next);
    toast.success('已全部标为已读');
  };

  return (
    <div className="screen padded-screen support-page">
      <div className="mini-header">
        <button className="back-button" onClick={() => go(homeForRole(profile?.role))} aria-label="返回"><span className="back-chevron" /></button>
        <strong>消息通知</strong>
        <button className="support-read-all" onClick={markAllRead} disabled={notices.length === 0}>
          <Check size={15} />全部已读
        </button>
      </div>
      {loading ? (
        <div className="rec-loading"><div className="rec-spinner" /><span>加载中…</span></div>
      ) : notices.length === 0 ? (
        <div className="rec-empty">
          <Bell size={40} className="rec-empty-icon" />
          <p>暂无消息通知</p>
        </div>
      ) : (
        <div className="support-notice-list">
          {notices.map(notice => {
            const unread = !readIds.includes(notice.id);
            return (
              <button key={notice.id} className={`support-notice${unread ? ' unread' : ''}`} onClick={() => openNotice(notice)}>
                <span className="support-notice-icon">
                  {notice.room.status === 'live' || notice.room.status === 'paused' ? <Radio size={18} /> : <CheckCircle2 size={18} />}
                </span>
                <span className="support-notice-body">
                  <b>{notice.title}</b>
                  <small>{notice.detail}</small>
                  <time>{formatNoticeTime(notice.at)}</time>
                </span>
                {unread && <i aria-label="未读" />}
                <ChevronRight size={16} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const FAQ_LIST = [
  { q: '实时字幕为什么只显示 50 条？', a: '为保证讲解页面滚动流畅，实时页只保留最新 50 条；导游可在字幕记录或已结束的讲解记录中查看全部字幕。' },
  { q: '在哪里查看会议纪要？', a: '结束讲解时勾选“生成会议纪要”，完成后进入底部“记录”，打开对应房间即可查看。' },
  { q: '英文字幕或语音生成失败怎么办？', a: '请先检查网络与百度翻译、短文本在线合成授权。系统会保留已生成的中文字幕，不会因英文处理失败丢失整场记录。' },
  { q: '游客听不到声音怎么办？', a: '确认导游端已开始讲解、游客已允许媒体自动播放，并检查两台设备网络。出现“直连降级模式”时，跨网络稳定性可能下降。' },
];

const CATEGORIES = ['功能问题', '账号问题', '语音字幕', '会议纪要', '意见建议', '其他'] as const;

export function HelpFeedbackScreen({ go }: Props) {
  const { profile } = useAuth();
  const [open, setOpen] = useState<number | null>(null);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('功能问题');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async () => {
    const trimmed = content.trim();
    if (trimmed.length < 5) {
      toast.error('请至少输入 5 个字');
      return;
    }
    if (trimmed.length > 1000) {
      toast.error('问题描述不超过 1000 字');
      return;
    }
    if (contact.trim().length > 100) {
      toast.error('联系方式不超过 100 字');
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      const { error } = await insertFeedback({
        role: profile?.role ?? 'tourist',
        category,
        content: trimmed,
        contact: contact.trim() || null,
      });
      if (error) {
        toast.error(`提交失败：${error}`);
        return;
      }
      setSubmitted(true);
      toast.success('反馈已提交');
    } catch (error) {
      toast.error(`提交失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="screen padded-screen ps-page help-feedback-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go(homeForRole(profile?.role))} aria-label="返回"><span className="back-chevron" /></button>
        <strong>帮助与反馈</strong><span />
      </div>
      <div className="ps-section">
        <div className="ps-section-title">常见问题</div>
        <div className="ps-card ps-card-faq">
          {FAQ_LIST.map((item, index) => (
            <div className="ps-faq-item" key={item.q}>
              <button className="ps-faq-q" onClick={() => setOpen(open === index ? null : index)} aria-expanded={open === index}>
                <HelpCircle size={15} className="ps-icon amber" />
                <span>{item.q}</span>
                {open === index ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
              {open === index && <div className="ps-faq-a">{item.a}</div>}
            </div>
          ))}
        </div>
      </div>
      <div className="ps-section">
        <div className="ps-section-title">意见反馈</div>
        <div className="ps-card">
          {submitted ? (
            <div className="ps-feedback-done">
              <CheckCircle2 size={36} className="ps-icon green" />
              <p>反馈已提交，感谢你的反馈！</p>
              <button className="ps-clear-btn" onClick={() => { setSubmitted(false); setContent(''); setContact(''); }}>再次反馈</button>
            </div>
          ) : (
            <>
              <div className="ps-feedback-label">问题类型</div>
              <div className="ps-category-grid">
                {CATEGORIES.map(item => (
                  <button
                    type="button"
                    key={item}
                    className={`ps-category-btn${category === item ? ' selected' : ''}`}
                    onClick={() => setCategory(item)}
                    aria-pressed={category === item}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <div className="ps-feedback-label" style={{ marginTop: 12 }}>问题描述 <span className="ps-required">*</span></div>
              <textarea aria-label="问题描述" className="ps-feedback-input" rows={5} value={content} maxLength={1000} onChange={event => setContent(event.target.value)} placeholder="请描述你遇到的问题或建议（5~1000 字）" />
              <div className="ps-feedback-count">{content.length}/1000</div>
              <div className="ps-feedback-label">联系方式 <span className="ps-optional">（选填）</span></div>
              <input aria-label="联系方式" className="ps-feedback-contact" value={contact} maxLength={100} onChange={event => setContact(event.target.value)} placeholder="手机号、微信号或邮箱" />
              <button className="ps-submit-btn ps-feedback-submit" onClick={submit} disabled={submitting || content.trim().length < 5}>
                <Send size={14} />{submitting ? '提交中…' : '提交反馈'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

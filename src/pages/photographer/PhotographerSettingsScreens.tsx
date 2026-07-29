/**
 * 摄影师设置子页（均受摄影师路由守卫保护）：
 * - PhotographerStoragePage  (C09-B) 存储与网络
 * - PhotographerPrivacyPage  (C09-C) 隐私与权限
 * - PhotographerHelpPage     (C09-D) 帮助与反馈
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  Wifi, WifiOff, HardDrive, Shield, HelpCircle,
  ChevronDown, ChevronUp, Trash2, Send, CheckCircle2,
  Lock, Camera, Image as ImageIcon, FileText, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { insertFeedback } from '@/api/feedbacks';
import { USER_AGREEMENT, PRIVACY_POLICY } from '@/lib/legalContent';

interface Props { go: (id: string) => void }

// ── localStorage 键白名单（仅清理这些，保留登录会话/业务数据）────────────
const SAFE_CLEAR_KEYS = [
  'shiguang-upload-quality',
  'shiguang-wifi-only',
  'shiguang-draft-feedback',
  'shiguang-cache-hint',
];

// ── 上传质量选项 ────────────────────────────────────────────────────────
const QUALITY_OPTIONS = [
  { value: 'original', label: '原图', desc: '保留完整画质，流量消耗较大' },
  { value: 'hd',       label: '高清', desc: '压缩至 1080p，兼顾画质与流量' },
  { value: 'economy',  label: '省流', desc: '压缩至 720p，显著节省流量' },
] as const;
type Quality = typeof QUALITY_OPTIONS[number]['value'];

// ═══════════════════════════════════════════════════════════════════════
// C09-B 存储与网络
// ═══════════════════════════════════════════════════════════════════════
export function PhotographerStoragePage({ go }: Props) {
  const [online, setOnline]   = useState(navigator.onLine);
  const [wifiOnly, setWifiOnly] = useState<boolean>(
    () => localStorage.getItem('shiguang-wifi-only') === 'true'
  );
  const [quality, setQuality] = useState<Quality>(
    () => (localStorage.getItem('shiguang-upload-quality') as Quality) ?? 'hd'
  );

  // 监听网络在线状态
  useEffect(() => {
    const onOnline  = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const handleWifiOnly = (v: boolean) => {
    setWifiOnly(v);
    localStorage.setItem('shiguang-wifi-only', String(v));
    toast.success(v ? '已开启仅 Wi-Fi 上传偏好' : '已关闭仅 Wi-Fi 上传偏好');
  };

  const handleQuality = (v: Quality) => {
    setQuality(v);
    localStorage.setItem('shiguang-upload-quality', v);
    toast.success('上传质量偏好已保存');
  };

  const handleClearCache = () => {
    SAFE_CLEAR_KEYS.forEach(k => localStorage.removeItem(k));
    // 重置 state 以反映清理结果
    setWifiOnly(false);
    setQuality('hd');
    toast.success('本地缓存已清理');
  };

  return (
    <div className="screen padded-screen ps-page">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-my')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>存储与网络</strong>
        <span />
      </div>

      {/* 网络状态 */}
      <div className="ps-section">
        <div className="ps-section-title">当前网络</div>
        <div className="ps-card">
          <div className="ps-row">
            {online
              ? <Wifi size={18} className="ps-icon green" />
              : <WifiOff size={18} className="ps-icon red" />}
            <span className="ps-row-label">{online ? '网络已连接' : '当前离线'}</span>
            <span className={`ps-badge ${online ? 'green' : 'red'}`}>
              {online ? '在线' : '离线'}
            </span>
          </div>
          <p className="ps-tip">注：浏览器无法可靠区分 Wi-Fi 与移动数据，网络类型仅供参考。</p>
        </div>
      </div>

      {/* 仅 Wi-Fi 上传 */}
      <div className="ps-section">
        <div className="ps-section-title">上传设置</div>
        <div className="ps-card">
          <div className="ps-row ps-row-between">
            <div>
              <span className="ps-row-label">仅 Wi-Fi 上传</span>
              <p className="ps-sub">浏览器可能无法准确识别网络类型</p>
            </div>
            <button
              className={`ps-toggle ${wifiOnly ? 'on' : ''}`}
              onClick={() => handleWifiOnly(!wifiOnly)}
              aria-pressed={wifiOnly}
              aria-label="仅Wi-Fi上传"
            >
              <span className="ps-toggle-knob" />
            </button>
          </div>
        </div>
      </div>

      {/* 上传质量 */}
      <div className="ps-section">
        <div className="ps-section-title">图片上传质量</div>
        <div className="ps-card">
          <p className="ps-tip" style={{ marginBottom: 12 }}>
            此偏好仅保存本地，不影响服务器上传压缩逻辑。
          </p>
          {QUALITY_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`ps-quality-item ${quality === opt.value ? 'selected' : ''}`}
              onClick={() => handleQuality(opt.value)}
            >
              <div className="ps-quality-dot" />
              <div>
                <span className="ps-quality-label">{opt.label}</span>
                <span className="ps-quality-desc">{opt.desc}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 缓存清理 */}
      <div className="ps-section">
        <div className="ps-section-title">本地缓存</div>
        <div className="ps-card">
          <p className="ps-tip" style={{ marginBottom: 12 }}>
            仅清理上传偏好、草稿等临时数据，不会删除登录状态、照片记录或房间业务数据。
          </p>
          <button
            className="ps-clear-btn"
            onClick={handleClearCache}
          >
            <Trash2 size={15} />
            清理本地缓存
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// C09-C 隐私与权限
// ═══════════════════════════════════════════════════════════════════════
type PermStatus = 'idle' | 'granted' | 'denied' | 'prompt' | 'unsupported';

interface PermState {
  camera: PermStatus;
  photos: PermStatus; // 相册（mediaDevices.getUserMedia 图片选择不需要显式权限，说明即可）
}

export function PhotographerPrivacyPage({ go }: Props) {
  const [perm, setPerm] = useState<PermState>({ camera: 'idle', photos: 'idle' });
  const [showAgreement, setShowAgreement] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  // 查询相机权限（不主动申请）
  const queryCamera = useCallback(async () => {
    if (!navigator.permissions) {
      setPerm(p => ({ ...p, camera: 'unsupported' }));
      return;
    }
    try {
      const res = await navigator.permissions.query({ name: 'camera' as PermissionName });
      setPerm(p => ({ ...p, camera: res.state as PermStatus }));
      res.onchange = () => setPerm(p => ({ ...p, camera: res.state as PermStatus }));
    } catch {
      setPerm(p => ({ ...p, camera: 'unsupported' }));
    }
  }, []);

  useEffect(() => { queryCamera(); }, [queryCamera]);

  // 主动申请相机权限
  const requestCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(t => t.stop());
      setPerm(p => ({ ...p, camera: 'granted' }));
      toast.success('相机权限已授予');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('denied') || msg.includes('NotAllowed')) {
        setPerm(p => ({ ...p, camera: 'denied' }));
        toast.error('相机权限被拒绝，请在浏览器/系统设置中手动开启');
      } else {
        setPerm(p => ({ ...p, camera: 'unsupported' }));
        toast.error('此浏览器不支持相机权限申请');
      }
    }
  };

  const statusLabel = (s: PermStatus) => {
    if (s === 'granted')     return { text: '已授权', cls: 'green' };
    if (s === 'denied')      return { text: '已拒绝', cls: 'red' };
    if (s === 'prompt')      return { text: '待确认', cls: 'amber' };
    if (s === 'unsupported') return { text: '请在系统设置管理', cls: 'muted' };
    return { text: '未检测', cls: 'muted' };
  };

  return (
    <div className="screen padded-screen ps-page">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-my')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>隐私与权限</strong>
        <span />
      </div>

      {/* 权限说明 */}
      <div className="ps-section">
        <div className="ps-section-title">应用权限</div>
        <div className="ps-card">
          {/* 相机 */}
          <div className="ps-perm-item">
            <div className="ps-perm-icon"><Camera size={16} /></div>
            <div className="ps-perm-body">
              <span className="ps-perm-name">相机</span>
              <span className="ps-perm-desc">用于拍摄并上传照片至当前房间</span>
            </div>
            <div className="ps-perm-right">
              {(() => {
                const { text, cls } = statusLabel(perm.camera);
                return <span className={`ps-badge ${cls}`}>{text}</span>;
              })()}
              {perm.camera !== 'granted' && perm.camera !== 'denied' && (
                <button className="ps-perm-btn" onClick={requestCamera}>申请</button>
              )}
              {perm.camera === 'denied' && (
                <span className="ps-perm-hint">请在浏览器设置中手动开启</span>
              )}
            </div>
          </div>
          {/* 相册（Web 选文件不需要额外权限，仅说明） */}
          <div className="ps-perm-item">
            <div className="ps-perm-icon"><ImageIcon size={16} /></div>
            <div className="ps-perm-body">
              <span className="ps-perm-name">相册 / 文件访问</span>
              <span className="ps-perm-desc">通过系统文件选择器访问，无需额外授权</span>
            </div>
            <div className="ps-perm-right">
              <span className="ps-badge green">系统管理</span>
            </div>
          </div>
        </div>
      </div>

      {/* 协议入口 */}
      <div className="ps-section">
        <div className="ps-section-title">协议与政策</div>
        <div className="ps-card">
          <button className="ps-menu-row" onClick={() => setShowAgreement(true)}>
            <FileText size={16} className="ps-icon green" />
            <span className="ps-row-label">用户协议</span>
            <span className="ps-menu-arrow">›</span>
          </button>
          <button className="ps-menu-row" onClick={() => setShowPrivacy(true)}>
            <Lock size={16} className="ps-icon green" />
            <span className="ps-row-label">隐私政策</span>
            <span className="ps-menu-arrow">›</span>
          </button>
        </div>
      </div>

      {/* 用户协议弹窗 */}
      {showAgreement && (
        <div className="ps-modal-overlay" onClick={() => setShowAgreement(false)}>
          <div className="ps-modal" onClick={e => e.stopPropagation()}>
            <div className="ps-modal-header">
              <strong>用户协议</strong>
              <button onClick={() => setShowAgreement(false)}><X size={18} /></button>
            </div>
            <div className="ps-modal-body">
              <pre className="ps-legal-text">{USER_AGREEMENT}</pre>
            </div>
          </div>
        </div>
      )}

      {/* 隐私政策弹窗 */}
      {showPrivacy && (
        <div className="ps-modal-overlay" onClick={() => setShowPrivacy(false)}>
          <div className="ps-modal" onClick={e => e.stopPropagation()}>
            <div className="ps-modal-header">
              <strong>隐私政策</strong>
              <button onClick={() => setShowPrivacy(false)}><X size={18} /></button>
            </div>
            <div className="ps-modal-body">
              <pre className="ps-legal-text">{PRIVACY_POLICY}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// C09-D 帮助与反馈
// ═══════════════════════════════════════════════════════════════════════
const FAQ_LIST = [
  {
    q: '如何加入房间？',
    a: '在任务页点击"加入房间"，输入导游提供的 6 位房间号，验证通过后等待导游审核即可进入。',
  },
  {
    q: '为什么需要导游审核？',
    a: '为保障讲解房间的安全性，摄影师加入前需由导游确认身份。通常审核仅需数秒，审核通过后会自动通知您。',
  },
  {
    q: '如何上传照片？',
    a: '进入已批准的房间后，点击底部"上传"Tab，选择本地照片即可上传。支持同时选择多张，上传进度实时显示。',
  },
  {
    q: '上传失败怎么办？',
    a: '请检查网络连接是否正常，并确认房间仍处于进行中状态。若反复失败，可尝试重新进入房间或联系导游确认权限。',
  },
];

const FEEDBACK_CATEGORIES = ['功能问题', '账号问题', '照片上传', '语音字幕', '意见建议', '其他'] as const;
type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];

export function PhotographerHelpPage({ go }: Props) {
  const { profile } = useAuth();
  const [open, setOpen] = useState<number | null>(null);
  const [category, setCategory] = useState<FeedbackCategory>('功能问题');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmitFeedback = async () => {
    const trimmed = content.trim();
    if (trimmed.length < 5) { toast.error('请至少输入 5 个字'); return; }
    if (trimmed.length > 1000) { toast.error('问题描述不超过 1000 字'); return; }
    if (contact.length > 100) { toast.error('联系方式不超过 100 字'); return; }
    if (submitting) return;
    setSubmitting(true);
    const { error } = await insertFeedback({
      role: profile?.role ?? 'photographer',
      category,
      content: trimmed,
      contact: contact.trim() || null,
    });
    setSubmitting(false);
    if (error) {
      toast.error('提交失败：' + error);
      return;
    }
    toast.success('反馈已提交');
    setSubmitted(true);
  };

  const handleReset = () => {
    setContent('');
    setContact('');
    setCategory('功能问题');
    setSubmitted(false);
  };

  return (
    <div className="screen padded-screen ps-page">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-my')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>帮助与反馈</strong>
        <span />
      </div>

      {/* 常见问题 */}
      <div className="ps-section">
        <div className="ps-section-title">常见问题</div>
        <div className="ps-card ps-card-faq">
          {FAQ_LIST.map((item, i) => (
            <div key={i} className="ps-faq-item">
              <button
                className="ps-faq-q"
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
              >
                <HelpCircle size={15} className="ps-icon amber" />
                <span>{item.q}</span>
                {open === i
                  ? <ChevronUp size={15} className="ps-faq-chevron" />
                  : <ChevronDown size={15} className="ps-faq-chevron" />}
              </button>
              {open === i && <div className="ps-faq-a">{item.a}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* 反馈表单 */}
      <div className="ps-section">
        <div className="ps-section-title">意见反馈</div>
        <div className="ps-card">
          {submitted ? (
            <div className="ps-feedback-done">
              <CheckCircle2 size={36} className="ps-icon green" />
              <p>反馈已提交，感谢您的反馈！</p>
              <button className="ps-clear-btn" onClick={handleReset} style={{ marginTop: 8 }}>再次反馈</button>
            </div>
          ) : (
            <>
              {/* 问题类型 */}
              <div className="ps-feedback-label">问题类型</div>
              <div className="ps-category-grid">
                {FEEDBACK_CATEGORIES.map(c => (
                  <button
                    key={c}
                    className={`ps-category-btn${category === c ? ' selected' : ''}`}
                    onClick={() => setCategory(c)}
                    type="button"
                  >{c}</button>
                ))}
              </div>
              {/* 问题描述 */}
              <div className="ps-feedback-label" style={{ marginTop: 12 }}>
                问题描述 <span className="ps-required">*</span>
              </div>
              <textarea
                className="ps-feedback-input"
                placeholder="请描述您遇到的问题或建议（5~1000 字）"
                value={content}
                onChange={e => setContent(e.target.value.slice(0, 1000))}
                rows={5}
              />
              <div className="ps-feedback-count">{content.length}/1000</div>
              {/* 联系方式 */}
              <div className="ps-feedback-label" style={{ marginTop: 8 }}>
                联系方式 <span className="ps-optional">（选填）</span>
              </div>
              <input
                className="ps-feedback-contact"
                placeholder="手机号、微信号或邮箱（方便我们回复）"
                value={contact}
                onChange={e => setContact(e.target.value.slice(0, 100))}
                type="text"
              />
              <button
                className="ps-submit-btn"
                onClick={handleSubmitFeedback}
                disabled={content.trim().length < 5 || submitting}
                style={{ marginTop: 14 }}
              >
                <Send size={14} />{submitting ? '提交中…' : '提交反馈'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

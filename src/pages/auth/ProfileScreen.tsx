// Profile 改用 useAvatarUploadFlow，删除本地重复的选图/校验/revoke/上传逻辑
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Check, UserRound, ChevronRight, LogOut, Edit3, Shield, Bell, HelpCircle, X, Phone, KeyRound, Landmark, Images, History } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { updateProfile } from '@/api/users';
import { toast } from 'sonner';
import { BottomNav } from '@/pages/guide/GuideScreens';
import { AvatarCropModal } from '@/components/AvatarCropModal';
import { useAvatarUploadFlow, AVATAR_ACCEPT } from '@/hooks/useAvatarUploadFlow';
import { supabase } from '@/db/supabase';

interface Props { go: (id: string) => void }

type Gender = 'male' | 'female';
type Role = 'guide' | 'tourist' | 'photographer';

/** 根据性别+身份返回对应默认头像路径 */
function getDefaultAvatar(gender: Gender, role: Role): string {
  const g = gender === 'male' ? 'male' : 'female';
  const r = role === 'guide' ? 'guide' : role === 'photographer' ? 'photographer' : 'tourist';
  return `/avatars/${g}-${r}.webp`;
}

export function Profile({ go }: Props) {
  const { user, profile, profileLoading, refreshProfile } = useAuth();
  // role 未就绪（null/undefined）时不设默认值，避免误用游客身份保存资料
  const role = profile?.role as Role | undefined;

  // ── 编辑态 vs 注册态 ──────────────────────────────────────────────────
  // 只要当前 user id 已有 profile（任意 role），就进入编辑态，禁止再次注册
  const isEditMode = !profileLoading && !!profile;

  const [nickname, setNickname] = useState(profile?.nickname ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [gender, setGender] = useState<Gender>((profile?.gender as Gender) ?? 'male');
  // 编辑态无需协议勾选；注册态需要
  const [agreed, setAgreed] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile?.avatar_url ?? null);
  const [busy, setBusy] = useState(false);

  // 头像上传共用 hook
  const {
    cropSrc, fileRef, handleFileChange, handleCropConfirm, handleCropClose,
  } = useAvatarUploadFlow({
    userId: user?.id,
    onSuccess: async (url) => {
      setAvatarUrl(url);
      await refreshProfile();
    },
  });

  // profile 加载完成后同步表单初始值（应对 profileLoading 异步场景）
  useEffect(() => {
    if (profile) {
      setNickname(profile.nickname ?? '');
      setPhone(profile.phone ?? '');
      setGender((profile.gender as Gender) ?? 'male');
      setAvatarUrl(profile.avatar_url ?? null);
    }
  }, [profile]);

  // 头像预览用的安全 role：仅影响默认头像图片路径，不用于保存
  const previewRole: Role = role ?? 'tourist';

  // 性别切换时，若头像是默认头像则跟随切换
  useEffect(() => {
    const prevDefault = getDefaultAvatar(gender === 'male' ? 'female' : 'male', previewRole);
    const currDefault = getDefaultAvatar(gender, previewRole);
    if (!avatarUrl || avatarUrl === prevDefault) {
      setAvatarUrl(currDefault);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gender]);

  // 首次进入若无头像，设置默认头像
  useEffect(() => {
    if (!avatarUrl) setAvatarUrl(getDefaultAvatar(gender, previewRole));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async () => {
    // role 未就绪时拒绝提交，防止以 undefined/tourist 身份写入
    if (!role) { toast.error('身份信息未加载，请稍候重试'); return; }
    // 注册态：需同意协议
    if (!isEditMode && !agreed) { toast.error('请先同意用户协议与隐私政策'); return; }
    if (!nickname.trim()) { toast.error('请填写昵称'); return; }
    if (!user) return;
    setBusy(true);
    const finalAvatar = avatarUrl || getDefaultAvatar(gender, role);
    const { error } = await updateProfile(user.id, {
      nickname: nickname.trim(),
      phone: phone.trim() || null,
      avatar_url: finalAvatar,
      gender,
    });
    setBusy(false);
    if (error) { toast.error('保存失败：' + error); return; }
    await refreshProfile();
    toast.success(isEditMode ? '资料已保存' : '注册完成');
    // 编辑态：返回各自首页；注册态：也一样
    if (role === 'guide') go('guide-home');
    else if (role === 'photographer') go('photographer-my');
    else go('room-list');
  };

  const roleLabel = role === 'guide' ? '导游' : role === 'photographer' ? '摄影师' : '游客';

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <span />
        <strong>{isEditMode ? '编辑个人资料' : '完善个人资料'}</strong>
        <span />
      </div>
      {!isEditMode && <p className="profile-intro">完善信息，开启你的拾光旅伴之旅</p>}

      <div className="profile-form-card">
        {/* 头像 */}
        <section className="profile-photo-section">
          <h3>头像</h3>
          <div
            className="profile-photo-crop"
            style={{ backgroundImage: `url(${avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
          >
            <button aria-label="更换头像" onClick={() => fileRef.current?.click()}>
              <Camera />
            </button>
          </div>
          <p>点击头像可更换照片</p>
          <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} style={{ display: 'none' }} onChange={handleFileChange} />
        </section>

        {/* 性别 */}
        <section className="profile-field">
          <h3>性别</h3>
          <div>
            <div className="gender-select">
              <button
                className={`gender-btn${gender === 'male' ? ' active' : ''}`}
                onClick={() => setGender('male')}
                type="button"
              >
                ♂ 男
              </button>
              <button
                className={`gender-btn${gender === 'female' ? ' active' : ''}`}
                onClick={() => setGender('female')}
                type="button"
              >
                ♀ 女
              </button>
            </div>
          </div>
        </section>

        {/* 昵称 */}
        <section className="profile-field">
          <h3>昵称</h3>
          <div>
            <input
              className="profile-input"
              value={nickname}
              placeholder="请输入昵称"
              onChange={e => setNickname(e.target.value)}
            />
          </div>
        </section>

        {/* 手机号 */}
        <section className="profile-field phone-field">
          <h3>手机号</h3>
          <div>
            <input
              className="profile-input"
              value={phone}
              placeholder="请输入手机号（选填）"
              onChange={e => setPhone(e.target.value)}
            />
          </div>
        </section>

        {/* 当前身份 */}
        <section className="profile-field">
          <h3>当前身份</h3>
          <div>
            <strong>{roleLabel}</strong>
            <em className="identity-chip">
              <UserRound />
              {roleLabel}
            </em>
          </div>
        </section>
      </div>

      {/* 协议勾选：仅注册态显示 */}
      {!isEditMode && (
        <div className="agreement-card" onClick={() => setAgreed(a => !a)} style={{ cursor: 'pointer' }}>
          <b className={agreed ? 'checked' : ''}>
            <Check />
          </b>
          <span>我已阅读并同意 <strong>《用户协议》</strong> 和 <strong>《隐私政策》</strong></span>
        </div>
      )}

      {/* 加载中：profileLoading 尚未完成时隐藏提交按钮，避免注册/编辑态判定前可提交 */}
      {!profileLoading && (
        <button className="primary-button green" onClick={handleSubmit} disabled={busy}>
          {busy ? '保存中…' : isEditMode ? '保存修改' : '完成注册'}
        </button>
      )}

      {/* 裁剪弹窗：选图后弹出，取消不改动头像 */}
      {cropSrc && (
        <AvatarCropModal
          src={cropSrc}
          onConfirm={handleCropConfirm}
          onCancel={handleCropClose}
        />
      )}
    </div>
  );
}

// ─── 我的页面 ─────────────────────────────────────────
export function MyPage({ go }: Props) {
  const { user, profile, signOut, refreshProfile, setCurrentRoom, sendPhoneOtp, updatePhone } = useAuth();
  const role: Role = (profile?.role as Role) ?? 'tourist';
  const roleLabel = role === 'guide' ? '导游' : role === 'photographer' ? '摄影师' : '游客';
  const roleIcon = role === 'guide' ? '🧭' : role === 'photographer' ? '📷' : '🎒';

  // 编辑模态框状态
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState(profile?.nickname ?? '');
  const [gender, setGender] = useState<Gender>((profile?.gender as Gender) ?? 'male');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile?.avatar_url ?? null);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // 头像上传共用 hook
  const {
    cropSrc, fileRef, handleFileChange, handleCropConfirm, handleCropClose,
  } = useAvatarUploadFlow({
    userId: user?.id,
    onSuccess: async (url) => {
      setAvatarUrl(url);
      await refreshProfile();
    },
  });

  // 手机号换绑状态
  const [phoneStep, setPhoneStep] = useState<'display' | 'input' | 'otp'>('display');
  const [newPhone, setNewPhone] = useState('');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [countdown, setCountdown] = useState(0);
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 每次 profile 更新同步本地表单
  useEffect(() => {
    setNickname(profile?.nickname ?? '');
    setGender((profile?.gender as Gender) ?? 'male');
    setAvatarUrl(profile?.avatar_url ?? null);
  }, [profile]);

  // 关闭编辑时重置手机号流程
  const closeEditing = () => {
    setEditing(false);
    setPhoneStep('display');
    setNewPhone('');
    setOtp(['', '', '', '', '', '']);
    if (timerRef.current) clearInterval(timerRef.current);
    setCountdown(0);
  };

  const handleSave = async () => {
    if (!nickname.trim()) { toast.error('昵称不能为空'); return; }
    if (!user) return;
    setBusy(true);
    const { error } = await updateProfile(user.id, {
      nickname: nickname.trim(),
      avatar_url: avatarUrl ?? profile?.avatar_url ?? null,
      gender,
    });
    setBusy(false);
    if (error) { toast.error('保存失败：' + error); return; }
    await refreshProfile();
    closeEditing();
    toast.success('资料已保存');
  };

  // 发送验证码
  const handleSendOtp = async () => {
    const cleaned = newPhone.replace(/\s/g, '');
    if (!/^1[3-9]\d{9}$/.test(cleaned)) { toast.error('请输入正确的手机号'); return; }
    setBusy(true);
    const { error } = await sendPhoneOtp(cleaned);
    setBusy(false);
    if (error) { toast.error('发送失败：' + error); return; }
    setPhoneStep('otp');
    setOtp(['', '', '', '', '', '']);
    setCountdown(60);
    timerRef.current = setInterval(() => {
      setCountdown(c => { if (c <= 1) { clearInterval(timerRef.current!); return 0; } return c - 1; });
    }, 1000);
    toast.success('验证码已发送');
    setTimeout(() => otpRefs.current[0]?.focus(), 100);
  };

  // 输入验证码处理
  const handleOtpChange = (idx: number, val: string) => {
    if (!/^\d?$/.test(val)) return;
    const next = [...otp];
    next[idx] = val;
    setOtp(next);
    if (val && idx < 5) otpRefs.current[idx + 1]?.focus();
  };
  const handleOtpKeyDown = (idx: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0) otpRefs.current[idx - 1]?.focus();
  };

  // 确认验证码绑定手机号
  const handleVerifyOtp = async () => {
    const token = otp.join('');
    if (token.length < 6) { toast.error('请输入完整验证码'); return; }
    setBusy(true);
    const { error } = await updatePhone(newPhone.replace(/\s/g, ''), token);
    setBusy(false);
    if (error) { toast.error('绑定失败：' + error); return; }
    await refreshProfile();
    setPhoneStep('display');
    setNewPhone('');
    setOtp(['', '', '', '', '', '']);
    toast.success('手机号已更新');
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    setCurrentRoom(null);
    await signOut();
    go('login');
  };

  // 摄影师硬注销：调用 delete-account EF → 清理本地状态 → 退出
  const handleDeleteAccount = async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      const { error } = await supabase.functions.invoke('delete-account', { method: 'POST' });
      if (error) {
        const msg = await error?.context?.text?.();
        const parsed = (() => { try { return JSON.parse(msg ?? ''); } catch { return null; } })();
        toast.error(parsed?.error ?? '注销失败，请稍后重试');
        setDeleteBusy(false);
        return;
      }
      // 服务端确认成功后清理本地
      toast.success('账号已永久注销');
      // 清理本地存储中该账户的会话状态
      [
        'shiguang-current-room',
        'shiguang-role',
        'shiguang-draft-feedback',
        'shiguang-upload-quality',
        'shiguang-wifi-only',
        'shiguang-cache-hint',
      ].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
      setCurrentRoom(null);
      await signOut();
      go('login');
    } catch (e) {
      toast.error('注销请求失败，请检查网络后重试');
      setDeleteBusy(false);
    }
  };

  const backPage = role === 'guide' ? 'guide-home' : role === 'photographer' ? 'photographer-tasks' : 'room-list';
  const navVariant = role === 'guide' ? 'guide' : role === 'photographer' ? 'photographer' : 'tour';

  return (
    <div className="screen padded-screen has-tabbar my-page">
      {/* 顶部导航：摄影师无返回箭头（底部导航已可切换），其他角色保留 */}
      <div className="mini-header">
        {role !== 'photographer'
          ? <button className="back-button" onClick={() => go(backPage)} aria-label="返回"><span className="back-chevron" /></button>
          : <span />
        }
        <strong>我的</strong>
        <button className="my-edit-btn" onClick={() => setEditing(true)} aria-label="编辑资料">
          <Edit3 size={18} />
        </button>
      </div>

      {/* 头像 + 用户名 Hero */}
      <div className="my-hero">
        <div className="my-avatar-wrap">
          <img
            src={profile?.avatar_url ?? '/avatars/male-tourist.webp'}
            alt="头像"
            className="my-avatar"
          />
          <button className="my-avatar-edit" onClick={() => fileRef.current?.click()} aria-label="更换头像">
            <Camera size={14} />
          </button>
          <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} hidden onChange={handleFileChange} />
        </div>
        <h2 className="my-name">{profile?.nickname ?? '未设置昵称'}</h2>
        <span className="my-role-tag">
          <span>{roleIcon}</span>{roleLabel}
        </span>
      </div>

      {/* 账号信息卡片 */}
      <div className="my-section-card">
        <h3 className="my-section-title">账号信息</h3>
        <div className="my-info-row">
          <span className="my-info-label">昵称</span>
          <span className="my-info-value">{profile?.nickname ?? '—'}</span>
        </div>
        <div className="my-info-row">
          <span className="my-info-label">手机号</span>
          <span className="my-info-value">{profile?.phone ? profile.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '—'}</span>
        </div>
        <div className="my-info-row">
          <span className="my-info-label">性别</span>
          <span className="my-info-value">{profile?.gender === 'male' ? '男' : profile?.gender === 'female' ? '女' : '—'}</span>
        </div>
        <div className="my-info-row">
          <span className="my-info-label">身份</span>
          <span className="my-info-value my-role-badge">{roleIcon} {roleLabel}</span>
        </div>
      </div>

      {/* 功能列表 */}
      <div className="my-section-card my-menu-card">
        <button className="my-menu-item" onClick={() => setEditing(true)}>
          <span className="my-menu-icon green"><Edit3 size={16} /></span>
          <span className="my-menu-label">编辑个人资料</span>
          <ChevronRight size={16} className="my-menu-arrow" />
        </button>
        <button className="my-menu-item" onClick={() => go('identity-account')}>
          <span className="my-menu-icon blue"><UserRound size={16} /></span>
          <span className="my-menu-label">身份与账号</span>
          <ChevronRight size={16} className="my-menu-arrow" />
        </button>
        {role === 'guide' && (
          <button className="my-menu-item" onClick={() => { sessionStorage.setItem('kc_library_from', 'my'); go('kc-library'); }}>
            <span className="my-menu-icon amber"><Landmark size={16} /></span>
            <span className="my-menu-label">景区卡片库</span>
            <ChevronRight size={16} className="my-menu-arrow" />
          </button>
        )}
        {role !== 'photographer' && (
          <button className="my-menu-item" onClick={() => go(role === 'guide' ? 'guide-subtitle-settings' : 'subtitle-settings')}>
            <span className="my-menu-icon blue"><Shield size={16} /></span>
            <span className="my-menu-label">字幕偏好设置</span>
            <ChevronRight size={16} className="my-menu-arrow" />
          </button>
        )}
        {role !== 'photographer' && (
          <button className="my-menu-item">
            <span className="my-menu-icon amber"><Bell size={16} /></span>
            <span className="my-menu-label">消息通知</span>
            <ChevronRight size={16} className="my-menu-arrow" />
          </button>
        )}
        {role !== 'photographer' && (
          <button className="my-menu-item">
            <span className="my-menu-icon muted"><HelpCircle size={16} /></span>
            <span className="my-menu-label">帮助与反馈</span>
            <ChevronRight size={16} className="my-menu-arrow" />
          </button>
        )}
        {/* 摄影师专属：设置菜单直接内嵌在同一卡片 */}
        {role === 'photographer' && (
          <>
            <button className="my-menu-item" onClick={() => go('photographer-storage')}>
              <span className="my-menu-icon blue"><Images size={16} /></span>
              <span className="my-menu-label">存储与网络</span>
              <ChevronRight size={16} className="my-menu-arrow" />
            </button>
            <button className="my-menu-item" onClick={() => go('photographer-privacy')}>
              <span className="my-menu-icon green"><Landmark size={16} /></span>
              <span className="my-menu-label">隐私与权限</span>
              <ChevronRight size={16} className="my-menu-arrow" />
            </button>
            <button className="my-menu-item" onClick={() => go('photographer-help')}>
              <span className="my-menu-icon muted"><HelpCircle size={16} /></span>
              <span className="my-menu-label">帮助与反馈</span>
              <ChevronRight size={16} className="my-menu-arrow" />
            </button>
          </>
        )}
      </div>

      {/* 退出登录 */}
      <button
        className="my-signout-btn"
        onClick={() => setShowSignOutConfirm(true)}
        disabled={signingOut}
      >
        <LogOut size={16} />
        {signingOut ? '退出中…' : '退出登录'}
      </button>

      {/* 注销账号：三角色均显示，退出登录正下方；调用 delete-account EF 真实删除 */}
      <div className="my-deactivate-area">
        <button
          className="my-deactivate-btn"
          onClick={() => setShowDeleteConfirm(true)}
        >
          注销账号
        </button>
      </div>

      <p className="my-version">拾光旅伴 v1.0.0</p>

      <BottomNav active="我的" go={go} variant={navVariant} />

      {/* ─── 编辑资料模态框 ─── */}
      {editing && (
        <div className="my-modal-overlay" onClick={closeEditing}>
          <div className="my-modal" onClick={e => e.stopPropagation()}>
            <div className="my-modal-header">
              <strong>编辑个人资料</strong>
              <button onClick={closeEditing} aria-label="关闭"><X size={20} /></button>
            </div>

            {/* 头像 */}
            <div className="my-modal-avatar-row">
              <img
                src={avatarUrl ?? '/avatars/male-tourist.webp'}
                alt="头像"
                className="my-modal-avatar"
              />
              <button className="my-modal-avatar-change" onClick={() => fileRef.current?.click()}>
                <Camera size={14} />更换头像
              </button>
            </div>

            {/* 性别 */}
            <div className="my-modal-field">
              <label>性别</label>
              <div className="gender-select">
                <button className={`gender-btn${gender === 'male' ? ' active' : ''}`} onClick={() => setGender('male')} type="button">♂ 男</button>
                <button className={`gender-btn${gender === 'female' ? ' active' : ''}`} onClick={() => setGender('female')} type="button">♀ 女</button>
              </div>
            </div>

            {/* 昵称 */}
            <div className="my-modal-field">
              <label>昵称</label>
              <input className="profile-input" value={nickname} placeholder="请输入昵称" onChange={e => setNickname(e.target.value)} />
            </div>

            {/* ─── 手机号换绑区域 ─── */}
            <div className="my-modal-field">
              <label>手机号</label>
              {phoneStep === 'display' && (
                <div className="phone-change-row">
                  <span className="phone-current">
                    {profile?.phone ? profile.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '未绑定'}
                  </span>
                  <button className="phone-change-btn" type="button" onClick={() => { setPhoneStep('input'); setNewPhone(''); }}>
                    <Phone size={13} />{profile?.phone ? '更换手机号' : '绑定手机号'}
                  </button>
                </div>
              )}
              {phoneStep === 'input' && (
                <div className="phone-bind-box">
                  <div className="phone-input-row">
                    <span className="phone-prefix">+86</span>
                    <input
                      className="profile-input"
                      type="tel"
                      value={newPhone}
                      placeholder="请输入新手机号"
                      maxLength={11}
                      onChange={e => setNewPhone(e.target.value.replace(/\D/g, ''))}
                      autoFocus
                    />
                  </div>
                  <div className="phone-bind-actions">
                    <button className="phone-cancel-btn" type="button" onClick={() => setPhoneStep('display')}>取消</button>
                    <button className="phone-send-btn" type="button" onClick={handleSendOtp} disabled={busy}>
                      {busy ? '发送中…' : '发送验证码'}
                    </button>
                  </div>
                </div>
              )}
              {phoneStep === 'otp' && (
                <div className="phone-bind-box">
                  <p className="phone-otp-hint">验证码已发送至 <b>+86 {newPhone}</b></p>
                  <div className="otp-boxes">
                    {otp.map((v, i) => (
                      <input
                        key={i}
                        ref={el => { otpRefs.current[i] = el; }}
                        className="otp-box"
                        type="tel"
                        inputMode="numeric"
                        maxLength={1}
                        value={v}
                        onChange={e => handleOtpChange(i, e.target.value)}
                        onKeyDown={e => handleOtpKeyDown(i, e)}
                      />
                    ))}
                  </div>
                  <div className="phone-bind-actions">
                    <button
                      className="phone-cancel-btn"
                      type="button"
                      onClick={() => { setPhoneStep('input'); setOtp(['', '', '', '', '', '']); }}
                    >
                      重新输入
                    </button>
                    <button
                      className="phone-resend-btn"
                      type="button"
                      disabled={countdown > 0 || busy}
                      onClick={handleSendOtp}
                    >
                      {countdown > 0 ? `${countdown}s 后重发` : '重新发送'}
                    </button>
                  </div>
                  <button className="primary-button green" style={{ marginTop: 12 }} onClick={handleVerifyOtp} disabled={busy || otp.join('').length < 6}>
                    <KeyRound size={15} />{busy ? '绑定中…' : '确认绑定'}
                  </button>
                </div>
              )}
            </div>

            {/* 保存其他资料（手机号在 otp 步骤时隐藏主保存按钮） */}
            {phoneStep !== 'otp' && (
              <button className="primary-button green" onClick={handleSave} disabled={busy}>
                {busy ? '保存中…' : <><Check size={15} />保存修改</>}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ─── 退出确认弹窗 ─── */}
      {showSignOutConfirm && (
        <div className="my-modal-overlay" onClick={() => setShowSignOutConfirm(false)}>
          <div className="my-confirm-modal" onClick={e => e.stopPropagation()}>
            <LogOut size={32} className="my-confirm-icon" />
            <h3>确认退出登录？</h3>
            <p>退出后需要重新登录才能使用完整功能</p>
            <div className="my-confirm-actions">
              <button className="my-confirm-cancel" onClick={() => setShowSignOutConfirm(false)}>取消</button>
              <button className="my-confirm-ok" onClick={handleSignOut} disabled={signingOut}>
                {signingOut ? '退出中…' : '确认退出'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 注销账号确认弹窗（三角色通用，调用 delete-account EF 真实删除） ─── */}
      {showDeleteConfirm && (
        <div className="my-modal-overlay" onClick={() => !deleteBusy && setShowDeleteConfirm(false)}>
          <div className="my-confirm-modal" onClick={e => e.stopPropagation()}>
            <History size={32} className="my-confirm-icon" />
            <h3>注销账号</h3>
            <p>注销后，账号、个人资料、房间记录和已上传内容将永久删除且无法恢复。</p>
            <div className="my-confirm-actions">
              <button
                className="my-confirm-cancel"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleteBusy}
              >取消</button>
              <button
                className="my-confirm-ok danger"
                onClick={handleDeleteAccount}
                disabled={deleteBusy}
              >{deleteBusy ? '注销中…' : '永久注销'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 裁剪弹窗：选图后弹出，取消不改动头像 */}
      {cropSrc && (
        <AvatarCropModal
          src={cropSrc}
          onConfirm={handleCropConfirm}
          onCancel={handleCropClose}
        />
      )}
    </div>
  );
}

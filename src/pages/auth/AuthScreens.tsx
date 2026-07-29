import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, Settings2, X } from 'lucide-react';
import { updateRole } from '@/api/users';
import { fetchMyProfile } from '@/api/profiles';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import type { UserRole } from '@/types/types';
import { USER_AGREEMENT, PRIVACY_POLICY } from '@/lib/legalContent';
import { supabase } from '@/db/supabase';

interface Props { go: (id: string) => void }

// ─── 登录（手机号 + 验证码） ─────────────────────────────
export function Login({ go }: Props) {
  const { sendPhoneOtp, verifyPhoneOtp, refreshProfile } = useAuth();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [legalModal, setLegalModal] = useState<'agreement' | 'privacy' | null>(null);

  // 倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const handleSendOtp = async () => {
    const cleaned = phone.replace(/\s/g, '');
    if (!/^1[3-9]\d{9}$/.test(cleaned)) {
      toast.error('请输入正确的手机号');
      return;
    }
    setBusy(true);
    const { error } = await sendPhoneOtp(cleaned);
    setBusy(false);
    if (error) { toast.error(error); return; }
    toast.success('验证码已发送');
    setStep('otp');
    setCountdown(60);
    setTimeout(() => inputRefs.current[0]?.focus(), 100);
  };

  const handleOtpChange = (idx: number, val: string) => {
    const digits = val.replace(/\D/g, '');
    // 支持粘贴：一次性填入多位数字
    if (digits.length > 1) {
      const next = [...otp];
      digits.split('').slice(0, 6).forEach((d, i) => { next[i] = d; });
      setOtp(next);
      const focusIdx = Math.min(digits.length, 5);
      inputRefs.current[focusIdx]?.focus();
      if (next.every(d => d)) handleVerify(next.join(''));
      return;
    }
    const digit = digits.slice(-1);
    const next = [...otp];
    next[idx] = digit;
    setOtp(next);
    if (digit && idx < 5) inputRefs.current[idx + 1]?.focus();
    // 全部填完自动验证
    if (next.every(d => d) && next.join('').length === 6) {
      handleVerify(next.join(''));
    }
  };

  const handleOtpKeyDown = (idx: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus();
    }
  };

  // 焦点守卫：点任意格子时，跳到第一个空格
  const handleOtpFocus = (idx: number) => {
    const firstEmpty = otp.findIndex(d => !d);
    const target = firstEmpty === -1 ? 5 : firstEmpty;
    if (target !== idx) {
      // 用 setTimeout 避免与浏览器原生 focus 事件竞争
      setTimeout(() => inputRefs.current[target]?.focus(), 0);
    }
  };

  const handleVerify = async (code?: string) => {
    const token = code ?? otp.join('');
    if (token.length !== 6) { toast.error('请输入 6 位验证码'); return; }
    setBusy(true);
    const { error } = await verifyPhoneOtp(phone.replace(/\s/g, ''), token);
    if (error) { setBusy(false); toast.error(error); setOtp(['', '', '', '', '', '']); return; }
    // 登录成功：直接从 API 拿最新 profile（绕过 useState 异步闭包问题）
    // 同时触发 refreshProfile 更新全局 Context
    const authUser = supabase.auth;
    const { data: { user: freshUser } } = await authUser.getUser();
    const latestProfile = freshUser ? await fetchMyProfile() : null;
    refreshProfile(); // 异步更新 Context，不等待
    setBusy(false);
    toast.success('登录成功');
    // 根据已有角色决定跳转，实现幂等跳过
    const role = latestProfile?.role;
    if (!role) {
      go('role');               // 新用户：选角色
    } else if (!latestProfile?.nickname) {
      go('profile');            // 有角色但未填昵称：完善资料
    } else if (role === 'guide') {
      go('guide-home');         // 导游直接进主页
    } else if (role === 'photographer') {
      go('photographer-tasks'); // 摄影师直接进主页
    } else {
      go('room-list');          // 游客直接进房间列表
    }
  };

  return (
    <div className="screen login-screen">
      {/* ── 品牌区 ── */}
      <div className="login-brand">
        <span className="brand-logo-crop" />
        <h2>拾光旅伴</h2>
        <p>让每一次旅行，都被记录</p>
      </div>

      {/* ── 主视觉图 ── */}
      <div className="login-hero-photo" role="img" aria-label="导游在故宫为游客讲解" />

      {/* ── 登录操作卡片 ── */}
      <div className="login-card">
        {step === 'phone' ? (
          <>
            {/* 手机号输入框：+86 内嵌，有竖分隔线 */}
            <div className="login-phone-wrap">
              <span className="login-prefix">+86</span>
              <span className="login-divider" aria-hidden="true" />
              <input
                className="login-phone-input"
                aria-label="手机号"
                placeholder="请输入手机号"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                inputMode="numeric"
                maxLength={11}
                autoComplete="tel-national"
              />
            </div>
            {/* 获取验证码按钮 */}
            <button
              className="login-otp-btn"
              onClick={handleSendOtp}
              disabled={busy}
            >
              {busy ? '发送中…' : '获取验证码'}
            </button>
            {/* 协议文字 */}
            <p className="login-agreement">
              登录即代表同意{' '}
              <b
                className="login-agreement-link"
                onClick={() => setLegalModal('agreement')}
              >《服务协议》</b>
              {' '}与{' '}
              <b
                className="login-agreement-link"
                onClick={() => setLegalModal('privacy')}
              >《隐私政策》</b>
              <br />
              <span>未注册手机号将自动创建账号</span>
            </p>
          </>
        ) : (
          <>
            <p style={{ textAlign: 'center', color: '#555', fontSize: 14, marginBottom: 16 }}>
              验证码已发送至 <b>+86 {phone}</b>
            </p>
            {/* 6 位验证码输入框 */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 20 }}>
              {otp.map((digit, idx) => (
                <input
                  key={idx}
                  ref={el => { inputRefs.current[idx] = el; }}
                  value={digit}
                  onChange={e => handleOtpChange(idx, e.target.value)}
                  onKeyDown={e => handleOtpKeyDown(idx, e)}
                  onFocus={() => handleOtpFocus(idx)}
                  inputMode="numeric"
                  maxLength={1}
                  style={{
                    width: 44, height: 52, textAlign: 'center', fontSize: 22, fontWeight: 700,
                    border: `2px solid ${digit ? 'var(--green)' : '#dce9e0'}`,
                    borderRadius: 10, outline: 'none', background: '#fff',
                    transition: 'border-color .15s',
                  }}
                />
              ))}
            </div>
            <button
              className="primary-button green"
              onClick={() => handleVerify()}
              disabled={busy || otp.some(d => !d)}
              style={{ width: '100%' }}
            >
              {busy ? '验证中…' : '确认登录'}
            </button>
            <button
              onClick={handleSendOtp}
              disabled={countdown > 0 || busy}
              style={{
                width: '100%', marginTop: 10, background: 'none', border: 'none',
                color: countdown > 0 ? '#b0bcb2' : 'var(--green)',
                fontSize: 14, cursor: countdown > 0 ? 'default' : 'pointer',
              }}
            >
              {countdown > 0 ? `重新发送（${countdown}s）` : '重新发送验证码'}
            </button>
            <button
              onClick={() => { setStep('phone'); setOtp(['', '', '', '', '', '']); }}
              style={{ width: '100%', marginTop: 4, background: 'none', border: 'none', color: '#8a9289', fontSize: 13, cursor: 'pointer' }}
            >
              修改手机号
            </button>
          </>
        )}
      </div>

      {/* 协议弹窗 */}
      {legalModal && (
        <div className="ps-modal-overlay" onClick={() => setLegalModal(null)}>
          <div className="ps-modal" onClick={e => e.stopPropagation()}>
            <div className="ps-modal-header">
              <strong>{legalModal === 'agreement' ? '用户协议' : '隐私政策'}</strong>
              <button onClick={() => setLegalModal(null)}><X size={18} /></button>
            </div>
            <div className="ps-modal-body">
              <pre className="ps-legal-text">
                {legalModal === 'agreement' ? USER_AGREEMENT : PRIVACY_POLICY}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 身份选择 ───────────────────────────────────────────
type RoleItem = ['guide' | 'tourist' | 'photographer', string, string, string, string];

export function RoleSelect({ go }: Props) {
  const { profile, user, refreshProfile } = useAuth();
  const items: RoleItem[] = [
    ['guide', '导游', '创建讲解房、', '实时讲解', 'profile'],
    ['tourist', '游客', '收听讲解、', '查看景区资料', 'room-list'],
    ['photographer', '摄影师', '上传照片、', '管理相册', 'photographer-tasks'],
  ];

  // 已注册账号（有 role）禁止停留在 role 页
  // - 未填昵称 → 完善资料（首次注册流程最后一步）
  // - 已完善资料 → 身份与账号（已有账号不走注册流程）
  useEffect(() => {
    if (!profile?.role) return;
    if (!profile?.nickname) { go('profile'); return; }
    go('identity-account');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.role, profile?.nickname]);

  const handleSelect = async (role: UserRole, target: string) => {
    // 将选择的角色写入 DB，失败则 toast 并留在当前页
    if (user) {
      const { error: roleErr } = await updateRole(user.id, role);
      if (roleErr) {
        toast.error('身份设置失败，请重试：' + roleErr);
        return;
      }
      await refreshProfile();
    }
    // 用独立的 fetchMyProfile 拿最新快照，避免 state 未更新的竞态
    const latest = user ? await fetchMyProfile() : profile;
    if (!latest?.nickname) {
      go('profile');
    } else {
      go(target);
    }
  };

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <span />
        <strong>选择您的身份</strong>
        <span />
      </div>
      <div className="role-cards">
        {items.map(([role, name, line1, line2, target]) => (
          <button key={name} onClick={() => handleSelect(role, target)}>
            <span className={`role-photo role-photo-${role}`} />
            <span><strong>{name}</strong><small>{line1}<br />{line2}</small></span>
            <b><ChevronRight /></b>
          </button>
        ))}
      </div>

    </div>
  );
}

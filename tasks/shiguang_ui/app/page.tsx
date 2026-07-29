"use client";

import { useMemo, useState } from "react";

type Role = "公共" | "导游" | "游客" | "摄影师";
type PageDef = { id: string; name: string; role: Role; note: string };

const pages: PageDef[] = [
  { id: "login", name: "首页登录", role: "公共", note: "产品入口" },
  { id: "role", name: "身份选择", role: "公共", note: "导游、游客、摄影师" },
  { id: "profile", name: "资料完善", role: "公共", note: "首次登录资料" },
  { id: "guide-home", name: "导游首页", role: "导游", note: "讲解房管理" },
  { id: "guide-live", name: "导游讲解控制台", role: "导游", note: "中文原声讲解与游客互动" },
  { id: "create-room", name: "创建讲解房", role: "导游", note: "设置房间信息" },
  { id: "room-success", name: "房间创建成功", role: "导游", note: "房间号与邀请链接" },
  { id: "end-confirm", name: "结束讲解确认", role: "导游", note: "二次确认" },
  { id: "room-list", name: "游客房间列表", role: "游客", note: "主动查找房间" },
  { id: "invite", name: "邀请链接落地", role: "游客", note: "保留目标房间" },
  { id: "password", name: "密码验证", role: "游客", note: "统一六位密码" },
  { id: "listening", name: "游客实时收听", role: "游客", note: "双语字幕与提问" },
  { id: "question", name: "发送问题", role: "游客", note: "快捷输入问题" },
  { id: "subtitle-settings", name: "字幕与翻译设置", role: "游客", note: "仅影响当前游客" },
  { id: "card-alert", name: "景区卡片强提醒", role: "游客", note: "标题、图片、描述" },
  { id: "card-library", name: "景区卡片库", role: "导游", note: "导游主动推送" },
  { id: "card-detail", name: "双语景区详情", role: "游客", note: "中英双语介绍" },
  { id: "subtitle-history", name: "字幕历史", role: "游客", note: "长期回看讲解" },
  { id: "album", name: "房间电子相册", role: "游客", note: "普通房间相册" },
  { id: "photo", name: "照片详情", role: "游客", note: "保存与分享" },
  { id: "photographer-home", name: "摄影师首页", role: "摄影师", note: "已授权拍摄房间" },
  { id: "upload", name: "照片上传", role: "摄影师", note: "上传进度与历史" },
];

const roleOrder: Role[] = ["公共", "导游", "游客", "摄影师"];

export default function Home() {
  const [current, setCurrent] = useState("login");
  const [filter, setFilter] = useState<Role | "全部">("全部");
  const page = pages.find((item) => item.id === current) ?? pages[0];
  const index = pages.findIndex((item) => item.id === current);
  const filtered = useMemo(
    () => pages.filter((item) => filter === "全部" || item.role === filter),
    [filter],
  );

  const go = (id: string) => {
    setCurrent(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <main className="prototype-shell">
      <aside className="catalog-panel">
        <div className="brand-lockup">
          <Logo />
          <div>
            <strong>拾光旅伴</strong>
            <span>静态 H5 页面框架</span>
          </div>
        </div>

        <div className="scope-note">
          <span className="scope-dot" />
          <div>
            <strong>最新版功能口径</strong>
            <p>导游中文原声，游客独立选择中 / EN / 双语字幕；支持游客提问和导游推送景区卡片。</p>
          </div>
        </div>

        <div className="filter-row" aria-label="页面角色筛选">
          {(["全部", ...roleOrder] as const).map((item) => (
            <button
              key={item}
              className={filter === item ? "active" : ""}
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ))}
        </div>

        <nav className="page-list" aria-label="H5 页面列表">
          {filtered.map((item) => (
            <button
              key={item.id}
              className={current === item.id ? "active" : ""}
              onClick={() => go(item.id)}
            >
              <span className={`role-mark role-${item.role}`}>{item.role.slice(0, 1)}</span>
              <span className="page-copy">
                <strong>{item.name}</strong>
                <small>{item.note}</small>
              </span>
              <span className="chevron">›</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="preview-stage">
        <header className="preview-header">
          <div>
            <span className={`role-pill role-${page.role}`}>{page.role}</span>
            <h1>{page.name}</h1>
            <p>{page.note}</p>
          </div>
          <div className="step-controls">
            <button disabled={index <= 0} onClick={() => go(pages[index - 1].id)} aria-label="上一页">‹</button>
            <span>{index + 1} / {pages.length}</span>
            <button disabled={index >= pages.length - 1} onClick={() => go(pages[index + 1].id)} aria-label="下一页">›</button>
          </div>
        </header>

        <div className="phone-frame">
          <div className="phone-screen">
            <StatusBar />
            <ScreenRouter id={current} go={go} />
          </div>
        </div>

        <p className="prototype-tip">页面按钮仅用于静态流程预览，不连接真实语音、翻译、上传或登录服务。</p>
      </section>
    </main>
  );
}

function ScreenRouter({ id, go }: { id: string; go: (id: string) => void }) {
  switch (id) {
    case "login": return <Login go={go} />;
    case "role": return <RoleSelect go={go} />;
    case "profile": return <Profile go={go} />;
    case "guide-home": return <GuideHome go={go} />;
    case "guide-live": return <GuideLive go={go} />;
    case "create-room": return <CreateRoom go={go} />;
    case "room-success": return <RoomSuccess go={go} />;
    case "end-confirm": return <EndConfirm go={go} />;
    case "room-list": return <RoomList go={go} />;
    case "invite": return <Invite go={go} />;
    case "password": return <Password go={go} />;
    case "listening": return <Listening go={go} />;
    case "question": return <Question go={go} />;
    case "subtitle-settings": return <SubtitleSettings go={go} />;
    case "card-alert": return <CardAlert go={go} />;
    case "card-library": return <CardLibrary go={go} />;
    case "card-detail": return <CardDetail go={go} />;
    case "subtitle-history": return <SubtitleHistory go={go} />;
    case "album": return <Album go={go} />;
    case "photo": return <PhotoDetail go={go} />;
    case "photographer-home": return <PhotographerHome go={go} />;
    case "upload": return <Upload go={go} />;
    default: return null;
  }
}

function StatusBar() {
  return <div className="status-bar"><b>9:41</b><span>▮▮▮ ◒ ▰</span></div>;
}

function MiniHeader({ title, back, right = "•••  ◉" }: { title: string; back?: () => void; right?: string }) {
  return (
    <div className="mini-header">
      <button className="back-button" onClick={back} aria-label="返回">{back ? "‹" : ""}</button>
      <strong>{title}</strong>
      <span className="mini-actions">{right}</span>
    </div>
  );
}

function Logo() {
  return <span className="logo-mark"><i>◒</i><i>⌁</i></span>;
}

function ScenicArt({ label = "故宫文化之旅", compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className={`scenic-art ${compact ? "compact" : ""}`}>
      <span className="sun" />
      <span className="mountain mountain-a" />
      <span className="mountain mountain-b" />
      <span className="palace">🏯</span>
      <div className="scenic-caption"><small>文化探索</small><strong>{label}</strong></div>
    </div>
  );
}

function Avatar({ label = "张", photographer = false }: { label?: string; photographer?: boolean }) {
  return <span className={`avatar ${photographer ? "photographer" : ""}`}>{label}</span>;
}

function PrimaryButton({ children, onClick, tone = "green" }: { children: React.ReactNode; onClick?: () => void; tone?: "green" | "amber" | "ghost" }) {
  return <button className={`primary-button ${tone}`} onClick={onClick}>{children}</button>;
}

function Login({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen login-screen">
      <div className="login-brand"><Logo /><h2>拾光旅伴</h2><p>让每一次旅行，都被听见、看见与记录</p></div>
      <ScenicArt />
      <div className="login-footer">
        <PrimaryButton onClick={() => go("role")}>微信一键登录</PrimaryButton>
        <small>登录即代表同意《用户协议》和《隐私政策》</small>
      </div>
    </div>
  );
}

function RoleSelect({ go }: { go: (id: string) => void }) {
  const items = [
    ["🎙", "导游", "创建房间，开启实时中文讲解", "guide-home"],
    ["🎧", "游客", "收听讲解，查看字幕与景区卡片", "profile"],
    ["📷", "摄影师", "加入房间，上传旅行照片", "photographer-home"],
  ];
  return (
    <div className="screen padded-screen">
      <MiniHeader title="选择身份" back={() => go("login")} />
      <div className="section-heading"><span>欢迎来到拾光旅伴</span><h2>请选择您的身份</h2><p>身份决定进入后的页面与操作权限</p></div>
      <div className="role-cards">
        {items.map(([icon, name, desc, target]) => (
          <button key={name} onClick={() => go(target)}><span className="role-icon">{icon}</span><span><strong>{name}</strong><small>{desc}</small></span><b>›</b></button>
        ))}
      </div>
      <div className="safe-note">身份可在“我的”中申请切换，切换后需重新验证对应权限</div>
    </div>
  );
}

function Profile({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen">
      <MiniHeader title="完善资料" back={() => go("role")} />
      <div className="profile-avatar"><Avatar label="游" /><button>更换头像</button></div>
      <div className="form-card">
        <label>昵称<input defaultValue="Alex" /></label>
        <label>手机号码<input defaultValue="138 0000 8888" /></label>
        <label>常用语言<div className="segment"><button>中文</button><button className="active">English</button></div></label>
      </div>
      <PrimaryButton onClick={() => go("room-list")}>完成并进入</PrimaryButton>
      <p className="helper-copy">常用语言仅作为首次字幕推荐，可在收听页随时切换。</p>
    </div>
  );
}

function GuideHome({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen has-tabbar">
      <MiniHeader title="导游工作台" />
      <div className="welcome-row"><div><small>上午好</small><h2>张老师</h2></div><Avatar /></div>
      <div className="stats-grid"><div><b>2</b><span>累计房间</span></div><div><b>68</b><span>服务游客</span></div><div><b>12</b><span>景区卡片</span></div></div>
      <div className="title-row"><h3>我的讲解房</h3><button onClick={() => go("create-room")}>＋ 创建</button></div>
      <RoomCard status="讲解中" onClick={() => go("guide-live")} />
      <RoomCard title="颐和园夏日漫游" status="已结束" />
      <BottomNav active="房间" />
    </div>
  );
}

function RoomCard({ title = "故宫文化探索团", status, onClick }: { title?: string; status: string; onClick?: () => void }) {
  return (
    <button className="room-card" onClick={onClick}>
      <ScenicArt label={title} compact />
      <div className="room-card-copy"><span className={`status-chip ${status === "讲解中" ? "live" : ""}`}>{status}</span><h3>{title}</h3><p>房间号 888888 · 26 人</p></div><b>›</b>
    </button>
  );
}

function GuideLive({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen">
      <MiniHeader title="故宫文化探索团" back={() => go("guide-home")} />
      <p className="room-meta">房间号 888888 · 在线 <b>26</b> 人</p>
      <div className="live-host-card">
        <Avatar /><div><span className="live-label">● 正在讲解</span><h2>张老师</h2><Wave /><strong className="timer">00:18:36</strong><p>中文原声 · 游客收听中</p></div>
      </div>
      <div className="guide-tools">
        <button><span>👥</span>游客列表</button>
        <button><span>▤</span>字幕记录</button>
        <button onClick={() => go("card-library")}><span>▧</span>景点卡片</button>
        <button><span>↥</span>分享房间</button>
      </div>
      <PrimaryButton tone="ghost" onClick={() => go("end-confirm")}>🎙 结束讲解</PrimaryButton>
      <div className="question-stream"><span>清风：老师讲得真好</span><span>小林：声音很清楚</span><span>青禾：想了解太和殿</span></div>
    </div>
  );
}

function Wave() { return <div className="wave" aria-hidden="true">▂▅▃▇▆▃▅▂▆▃▇▅</div>; }

function CreateRoom({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen">
      <MiniHeader title="创建讲解房" back={() => go("guide-home")} />
      <div className="form-card room-form">
        <label>房间名称<input defaultValue="故宫文化探索团" /></label>
        <label>房间密码<div className="password-input"><input defaultValue="888888" /><button>随机生成</button></div></label>
        <label>讲解地点<input defaultValue="北京 · 故宫博物院" /></label>
        <label>封面<div className="cover-upload"><ScenicArt compact /><span>更换封面</span></div></label>
      </div>
      <div className="safe-note">房间密码统一为 6 位数字。游客无论通过列表还是邀请链接进入，都使用相同验证方式。</div>
      <PrimaryButton onClick={() => go("room-success")}>创建房间</PrimaryButton>
    </div>
  );
}

function RoomSuccess({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen success-screen">
      <MiniHeader title="创建成功" back={() => go("guide-home")} />
      <div className="success-mark">✓</div><h2>讲解房创建成功</h2><p>邀请游客和摄影师加入房间</p>
      <div className="success-card"><ScenicArt compact /><h3>故宫文化探索团</h3><span>房间号</span><strong>888888</strong><small>房间密码 888888</small></div>
      <PrimaryButton onClick={() => go("guide-live")}>进入讲解房</PrimaryButton>
      <PrimaryButton tone="ghost">分享邀请链接</PrimaryButton>
    </div>
  );
}

function EndConfirm({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen modal-page">
      <MiniHeader title="故宫文化探索团" back={() => go("guide-live")} />
      <div className="blur-content"><div className="live-host-card"><Avatar /><h2>张老师正在讲解</h2></div></div>
      <div className="sheet-modal"><span className="danger-icon">!</span><h2>确认结束本次讲解？</h2><p>结束后游客将停止接收实时语音，但仍可查看历史字幕、景区卡片和房间相册。</p><PrimaryButton onClick={() => go("guide-home")}>确认结束</PrimaryButton><button className="text-button" onClick={() => go("guide-live")}>继续讲解</button></div>
    </div>
  );
}

function RoomList({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen has-tabbar">
      <MiniHeader title="讲解房" />
      <div className="search-bar">⌕ 搜索房间名称或房间号</div>
      <div className="title-row"><h3>可加入的旅行房间</h3><span>3 个</span></div>
      {["故宫文化探索团", "颐和园夏日漫游", "天坛古建之旅"].map((name, i) => (
        <button className="list-room" key={name} onClick={() => go("password")}><Avatar label={["张", "李", "王"][i]} /><span><strong>{name}</strong><small>导游：{["张老师", "李老师", "王老师"][i]}</small><small>房间号 {888888 - i * 111111}</small></span><b>进入</b></button>
      ))}
      <BottomNav active="房间" />
    </div>
  );
}

function Invite({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen invite-screen">
      <MiniHeader title="房间邀请" back={() => go("login")} />
      <span className="invite-tag">张老师邀请你加入</span>
      <ScenicArt />
      <div className="invite-card"><Avatar /><div><h2>故宫文化探索团</h2><p>导游 张老师</p><p>房间号 888888</p></div></div>
      <p className="helper-copy">登录后将自动返回该房间，不会丢失邀请信息。</p>
      <PrimaryButton onClick={() => go("password")}>登录并加入房间</PrimaryButton>
    </div>
  );
}

function Password({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen password-screen">
      <MiniHeader title="验证房间密码" back={() => go("room-list")} />
      <div className="room-summary"><Avatar /><div><h2>故宫文化探索团</h2><p>导游 张老师 · 房间号 888888</p></div></div>
      <div className="password-box"><h3>请输入 6 位房间密码</h3><div className="code-row">{[8,8,8,8,8,8].map((n, i) => <span key={i}>{n}</span>)}</div><p>密码由导游提供，请注意区分房间号与房间密码</p></div>
      <PrimaryButton onClick={() => go("listening")}>验证并进入</PrimaryButton>
    </div>
  );
}

function Listening({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen has-tabbar listening-screen">
      <MiniHeader title="故宫文化探索团" back={() => go("room-list")} />
      <div className="language-tools"><div className="segment"><button>中</button><button>EN</button><button className="active">双语</button></div><button onClick={() => go("subtitle-settings")}>⚙ 字幕设置</button></div>
      <div className="listener-host"><Avatar /><div><h2>张老师正在讲解</h2><p><span className="green-dot" />连接稳定</p></div><Wave /><span>26 人在线</span></div>
      <div className="subtitle-card"><div className="subtitle-meta"><span>10:32</span><b>● 实时翻译 Live translation</b></div><p className="zh">各位游客，欢迎来到故宫紫禁城。这里曾是明清两代的皇家宫殿，已有近六百年的历史。</p><hr /><p className="en">Dear visitors, welcome to the Forbidden City. This was the imperial palace of the Ming and Qing dynasties for nearly 600 years.</p></div>
      <div className="message-list"><span><b>小林：</b>太壮观了！</span><span><b>Alex：</b>Amazing!</span><span><b>小雨：</b>屋顶为什么是黄色的？</span></div>
      <button className="ask-fab" onClick={() => go("question")}>提问</button>
      <BottomNav active="字幕" go={go} />
    </div>
  );
}

function Question({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen question-screen">
      <MiniHeader title="故宫文化探索团" back={() => go("listening")} />
      <div className="language-tools"><div className="segment"><button>中</button><button>EN</button><button className="active">双语</button></div></div>
      <div className="listener-host"><Avatar /><div><h2>张老师正在讲解</h2><p><span className="green-dot" />连接稳定</p></div><Wave /></div>
      <div className="subtitle-card compact-subtitle"><p className="zh">各位游客，欢迎来到故宫紫禁城。这里曾是明清两代的皇家宫殿。</p></div>
      <div className="composer"><textarea defaultValue="午门为什么叫午门？" /><div><span>最多 80 字</span><button onClick={() => go("listening")}>发送问题</button></div></div>
      <div className="fake-keyboard"><div>我　你　好　这　在　不　是　？</div><div className="keys">Q W E R T Y U I O P<br/>A S D F G H J K L<br/>　 Z X C V B N M　</div><div>123　　　空格　　　发送</div></div>
    </div>
  );
}

function SubtitleSettings({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen">
      <MiniHeader title="我的字幕设置" back={() => go("listening")} />
      <div className="room-summary"><Avatar /><div><h2>故宫文化探索团</h2><p>张老师 · 中文讲解中</p></div></div>
      <div className="settings-card"><SettingRow icon="中" title="显示中文字幕" desc="实时显示导游的中文讲解" /><SettingRow icon="EN" title="显示英文翻译" desc="同步提供英文实时翻译" /><div className="setting-direction"><span>译</span><strong>翻译方向</strong><b>中文 → English</b></div></div>
      <div className="preview-card"><div className="title-row"><h3>实时预览</h3><div className="segment"><button>中</button><button>EN</button><button className="active">双语</button></div></div><span className="preview-label">中文原文</span><p>大家看到的这座宫殿叫太和殿，是紫禁城中最大的殿宇。</p><span className="preview-label amber">英文译文</span><p>The palace you see here is the Hall of Supreme Harmony.</p></div>
      <div className="safe-note">设置只影响我的字幕显示，不影响导游中文原声和其他游客。</div>
      <PrimaryButton onClick={() => go("listening")}>保存我的设置</PrimaryButton>
    </div>
  );
}

function SettingRow({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return <div className="setting-row"><span>{icon}</span><div><strong>{title}</strong><small>{desc}</small></div><i className="switch on" /></div>;
}

function CardAlert({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen card-alert-screen">
      <div className="dimmed-listening"><MiniHeader title="故宫文化探索团" /><div className="listener-host"><Avatar /><h2>张老师正在讲解</h2></div><div className="subtitle-card"><p className="zh">各位游客，欢迎来到故宫紫禁城……</p></div></div>
      <div className="knowledge-modal"><span className="push-badge">🔔 导游刚刚推送</span><h2>太和殿</h2><ScenicArt label="太和殿" /><p>故宫三大殿之一，明清皇帝举行重大典礼的重要场所。</p><PrimaryButton onClick={() => go("card-detail")}>查看详情</PrimaryButton><button className="text-button" onClick={() => go("listening")}>稍后查看</button><div className="audio-continues"><Wave />讲解音频将继续播放</div></div>
    </div>
  );
}

function CardLibrary({ go }: { go: (id: string) => void }) {
  const cards = ["太和殿", "午门", "乾清宫", "角楼"];
  return (
    <div className="screen padded-screen">
      <MiniHeader title="景区卡片库" back={() => go("guide-live")} />
      <div className="search-bar">⌕ 搜索景点、文物或历史资料</div>
      <div className="title-row"><h3>故宫博物院</h3><button>＋ 新建卡片</button></div>
      <div className="knowledge-list">{cards.map((card, i) => <div key={card}><ScenicArt label={card} compact /><span><strong>{card}</strong><small>{i % 2 ? "宫殿建筑 · 历史资料" : "核心景点 · 建筑文化"}</small></span><button>推送</button></div>)}</div>
      <div className="safe-note">导游点击推送后，游客端将收到包含标题、图片和描述的强提醒卡片。</div>
    </div>
  );
}

function CardDetail({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen card-detail-screen">
      <MiniHeader title="景区详情" back={() => go("listening")} />
      <ScenicArt label="太和殿" />
      <article><span className="eyebrow">故宫 · 三大殿</span><h1>太和殿</h1><h3>Hall of Supreme Harmony</h3><div className="tag-row"><span>宫殿建筑</span><span>明清皇家建筑</span><span>建于 1420 年</span></div><h4>历史背景</h4><p>太和殿，俗称“金銮殿”，是紫禁城内规模最大、等级最高的宫殿，也是明清两代皇帝举行重大典礼的地方。</p><h4>Historical background</h4><p>The Hall of Supreme Harmony is the largest and highest-ranking hall in the Forbidden City, where emperors held grand ceremonies.</p></article>
    </div>
  );
}

function SubtitleHistory({ go }: { go: (id: string) => void }) {
  const records = [["10:30", "午门", "午门是紫禁城的正门，也是举行重要仪式的场所。"], ["10:36", "太和殿", "太和殿是故宫三大殿之一，明清皇帝在这里举行重大典礼。"], ["10:45", "乾清宫", "乾清宫是内廷后三宫之首。"]];
  return (
    <div className="screen padded-screen">
      <MiniHeader title="字幕历史" back={() => go("listening")} />
      <div className="language-tools"><div className="segment"><button>中文</button><button>English</button><button className="active">双语</button></div></div>
      <div className="history-date">今天 · 故宫文化探索团</div>
      <div className="timeline">{records.map(([time, title, text]) => <div key={time}><span>{time}</span><article><h3>{title}</h3><p>{text}</p><small>{title === "太和殿" ? "The Hall of Supreme Harmony was used for grand imperial ceremonies." : "English translation available"}</small></article></div>)}</div>
    </div>
  );
}

function Album({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen has-tabbar album-screen">
      <MiniHeader title="旅行相册" back={() => go("listening")} />
      <div className="album-hero"><ScenicArt label="故宫文化探索团" /><span>2026.07.14 · 86 张照片</span></div>
      <div className="title-row"><h3>今日照片</h3><span>摄影师 李老师</span></div>
      <div className="photo-grid">{Array.from({ length: 8 }).map((_, i) => <button key={i} onClick={() => go("photo")}><ScenicArt label="" compact /><span>{i % 3 === 0 ? "游客合影" : "故宫风景"}</span></button>)}</div>
      <BottomNav active="相册" go={go} />
    </div>
  );
}

function PhotoDetail({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen photo-screen">
      <MiniHeader title="1 / 86" back={() => go("album")} right="•••" />
      <div className="photo-canvas"><span className="large-palace">🏯</span><div className="photo-people">● ● ● ●</div></div>
      <div className="photo-info"><span>拍摄于 2026.07.14 10:48</span><strong>摄影师 李老师</strong></div>
      <div className="photo-actions"><button>♡<span>收藏</span></button><button>⇩<span>保存</span></button><button>↥<span>分享</span></button></div>
    </div>
  );
}

function PhotographerHome({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen has-tabbar">
      <MiniHeader title="摄影师工作台" />
      <div className="welcome-row"><div><small>今天也要记录好旅程</small><h2>李老师</h2></div><Avatar label="李" photographer /></div>
      <div className="title-row"><h3>我的拍摄房间</h3><button>加入房间</button></div>
      <div className="shooting-card"><ScenicArt label="故宫文化探索团" /><span className="status-chip live">拍摄中</span><h2>故宫文化探索团</h2><p>房间号 888888 · 已上传 128 张</p><PrimaryButton onClick={() => go("upload")}>进入上传</PrimaryButton></div>
      <div className="safe-note">摄影师只能进入已获导游授权的房间，上传照片自动归属于当前房间。</div>
      <BottomNav active="任务" />
    </div>
  );
}

function Upload({ go }: { go: (id: string) => void }) {
  return (
    <div className="screen padded-screen">
      <MiniHeader title="上传照片" back={() => go("photographer-home")} />
      <div className="room-summary"><ScenicArt label="故宫文化探索团" compact /><div><h2>故宫文化探索团</h2><p>房间号 888888</p></div></div>
      <button className="upload-zone"><span>＋</span><strong>选择旅行照片</strong><small>支持批量选择，照片将归属当前房间</small></button>
      <div className="upload-progress"><div className="title-row"><h3>正在上传</h3><b>68%</b></div><div className="progress-track"><i /></div><p>128 / 200 张 · Wi-Fi 上传中</p></div>
      <div className="title-row"><h3>最近上传</h3><span>全部查看</span></div>
      <div className="recent-grid">{Array.from({ length: 6 }).map((_, i) => <ScenicArt key={i} label="" compact />)}</div>
    </div>
  );
}

function BottomNav({ active, go }: { active: string; go?: (id: string) => void }) {
  const items = [["⌂", "房间", "room-list"], ["▤", "字幕", "listening"], ["▧", "相册", "album"]];
  return <div className="bottom-nav">{items.map(([icon, name, target]) => <button key={name} className={active === name ? "active" : ""} onClick={() => go?.(target)}><b>{icon}</b><span>{name}</span></button>)}</div>;
}

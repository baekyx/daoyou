## Vibe
- 新中式旅行导览风格（Chinese Garden Editorial）

## Color
- Primary: #1f7a4d
- On Primary: #ffffff
- Accent: #ffb547
- On Accent: #593b0c
- Background: #edf2ee
- Foreground: #222222
- Muted: #70756f
- Border: #e8e8e2
- Secondary: #159252

## Typography
- Heading: PingFang SC (family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif, weight: 600)
- Body: PingFang SC (family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif, weight: 400)

## Visual Language
- 核心视觉签名：以优雅山水渐变（浅绿-蜜黄-草绿）作为内容插画背景，衡山、日出与宫殿 emoji 营造东方景点氛围
- 材质与深度：柔和拉光投影（0 14px 44px rgba(36,64,47,0.1)），低饱和背景结合毛玻璃模糊（backdrop-filter）
- 容器与按钮：大圆角卡片（22-30px），渐变填充主按钮，消息气泡与状态芯片小面积点缀绿色
- 布局节奏：手机框架屏幕预览，左侧导航面板与右侧预览区分区，移动端单独展示

## Animation
- 入场：页面切换时淡入（200ms ease-out）
- 交互：按钮悬停缩放/80% 不透明度反馈，模态弹窗从底部向上滑入（180ms ease-out）
- 过渡：页面列表筛选过滤动画（简短淡出淡入 150ms）

## Forbidden
- 禁止重新设计或修改原有绿色主题与旅行景点插画
- 禁止使用纯白底 + 孤立表单的登录页
- 禁止混淆移动端与桌面端的导航逻辑

## Additional Notes
- 所有用户可见文案使用中文
- 直接复用用户提供的UI源码中的CSS规则，保持视觉一致性
- 移动端（≤820px）应收起左侧目录面板，手机框架展开为全屏

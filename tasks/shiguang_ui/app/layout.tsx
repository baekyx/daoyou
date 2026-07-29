import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拾光旅伴｜静态 H5 页面框架",
  description: "数字导游、双语字幕、游客提问、景区卡片与房间相册的静态 H5 UI 页面集。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

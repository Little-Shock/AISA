import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AISA 运行台",
  description: "面向多 Agent 研究任务的编排与观测控制台。"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

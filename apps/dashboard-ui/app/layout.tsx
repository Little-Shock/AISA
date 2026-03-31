import type { Metadata } from "next";
import localFont from "next/font/local";
import { Fira_Code, Press_Start_2P, VT323 } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const bodyFont = localFont({
  variable: "--font-body",
  display: "swap",
  src: [
    { path: "../public/fonts/aisa-cn-400.ttf", weight: "400", style: "normal" },
    { path: "../public/fonts/aisa-cn-500.ttf", weight: "500", style: "normal" },
    { path: "../public/fonts/aisa-cn-700.ttf", weight: "700", style: "normal" },
    { path: "../public/fonts/aisa-cn-900.ttf", weight: "900", style: "normal" }
  ]
});

const terminalFont = Fira_Code({
  subsets: ["latin"],
  variable: "--font-terminal"
});

const hudFont = VT323({
  subsets: ["latin"],
  variable: "--font-hud",
  weight: "400"
});

const pixelFont = Press_Start_2P({
  subsets: ["latin"],
  variable: "--font-pixel",
  weight: "400"
});

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
      <body
        className={`${bodyFont.variable} ${terminalFont.variable} ${hudFont.variable} ${pixelFont.variable} bg-background text-foreground antialiased`}
      >
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}

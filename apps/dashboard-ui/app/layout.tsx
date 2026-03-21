import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoResearch Swarm Dashboard",
  description: "Orchestration control plane for multi-agent research runs."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

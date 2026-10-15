import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TargetEval · 靶点结构解析可行性评估平台",
  description:
    "输入 UniProt ID、氨基酸序列或 Word 评估表，自动聚合 UniProt / RCSB PDB / PDBe / PubMed / BLAST 数据，生成蛋白靶点结构解析可行性评估报告。",
  keywords: [
    "结构生物学",
    "蛋白靶点",
    "可行性评估",
    "UniProt",
    "PDB",
    "Cryo-EM",
    "X-ray",
    "NMR",
    "CRO",
  ],
  icons: {
    icon: "/logo.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}

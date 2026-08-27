import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Integration Dashboard",
  description:
    "Turn a requirement into user stories and tasks, then push them to Jira, Linear, and Notion.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

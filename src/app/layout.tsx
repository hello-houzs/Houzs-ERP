import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HOUZS Operations",
  description: "HOUZS Operations — TMS · QMS · PMS",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

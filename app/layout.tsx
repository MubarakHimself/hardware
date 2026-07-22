import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  ),
  title: {
    default: "Hardware — Open project intelligence",
    template: "%s · Hardware",
  },
  description:
    "A source-grounded catalog of open-source projects discovered across timestamped videos.",
  applicationName: "Hardware",
  robots: {
    index: false,
    follow: false,
  },
  openGraph: {
    type: "website",
    siteName: "Hardware",
    title: "Hardware — Open project intelligence",
    description:
      "A source-grounded catalog of open-source projects discovered across timestamped videos.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 675,
        alt: "Hardware project intelligence catalog",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Hardware — Open project intelligence",
    description:
      "A source-grounded catalog of open-source projects discovered across timestamped videos.",
    images: ["/og.png"],
  },
};

function RuntimeClerkProvider({ children }: { children: React.ReactNode }) {
  if (process.env.DEMO_MODE === "true") return children;
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    throw new Error(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required unless DEMO_MODE=true.",
    );
  }
  return <ClerkProvider>{children}</ClerkProvider>;
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <RuntimeClerkProvider>{children}</RuntimeClerkProvider>
      </body>
    </html>
  );
}

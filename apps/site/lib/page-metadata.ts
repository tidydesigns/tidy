import type { Metadata } from "next";

export function pageMetadata(path: string, title: string, description: string): Metadata {
  const image = {
    url: "/share-card.png",
    width: 1200,
    height: 630,
    alt: "Tidy — an open-source design canvas for people and AI agents",
  };

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: "Tidy",
      title,
      description,
      url: path,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}

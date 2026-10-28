import type { Metadata } from "next";

export function pageMetadata(path: string, title: string, description: string): Metadata {
  const image = {
    url: "/share-card-hero-v3.png",
    width: 2400,
    height: 1260,
    alt: "Tidy in Instrument Serif, centered over the website’s monochrome clouds and colorful stepped artwork.",
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

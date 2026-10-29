import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PostImage } from "../../../components/editorial/post-image";
import { CloudFooter } from "../../../components/brand/cloud-footer";
import { PostList } from "../../../components/editorial/post-list";
import { StructuredData } from "../../../components/structured-data";
import { formatPostDate, getPost, getPosts } from "../../../lib/blog";
import { pageMetadata } from "../../../lib/page-metadata";
import { siteUrl } from "../../../lib/site-url";
import { appUrl, repositoryUrl } from "../../../lib/site-links";
import styles from "../../../components/editorial/editorial.module.css";

type Props = { params: Promise<{ slug: string }> };
export const dynamicParams = false;

export async function generateStaticParams() {
  return (await getPosts()).map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = await getPost((await params).slug);
  if (!post) notFound();
  const metadata = pageMetadata(
    `/blog/${post.slug}`,
    `${post.seoTitle ?? post.title} | Tidy`,
    post.description,
  );
  const image = post.coverImage
    ? { url: post.coverImage.share, width: 1200, height: 675, alt: post.coverAlt }
    : undefined;
  return {
    ...metadata,
    twitter: { ...metadata.twitter, ...(image ? { images: [image] } : {}) },
    authors: [{ name: "Tidy", url: new URL("/about", siteUrl).href }],
    openGraph: {
      ...metadata.openGraph,
      ...(image ? { images: [image] } : {}),
      type: "article",
      publishedTime: post.date,
      modifiedTime: post.updated ?? post.date,
      authors: [new URL("/about", siteUrl).href],
      section: post.category,
    },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const post = await getPost((await params).slug);
  if (!post) notFound();
  const url = new URL(`/blog/${post.slug}`, siteUrl).href;
  const related = (await getPosts()).filter((entry) => entry.slug !== post.slug).slice(0, 2);
  return (
    <>
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "BlogPosting",
              headline: post.title,
              description: post.description,
              url,
              mainEntityOfPage: url,
              datePublished: post.date,
              dateModified: post.updated ?? post.date,
              image: new URL(post.coverImage?.share ?? "/share-card-hero-v3.png", siteUrl).href,
              author: {
                "@type": "Organization",
                name: "Tidy",
                url: new URL("/about", siteUrl).href,
              },
              publisher: { "@type": "Organization", name: "Tidy", url: siteUrl.href },
            },
            {
              "@type": "BreadcrumbList",
              itemListElement: [
                {
                  "@type": "ListItem",
                  position: 1,
                  name: "Blog",
                  item: new URL("/blog", siteUrl).href,
                },
                { "@type": "ListItem", position: 2, name: post.title, item: url },
              ],
            },
          ],
        }}
      />
      <main id="main-content" tabIndex={-1} className={styles.page}>
        <article>
          <header className={`${styles.intro} ${styles.articleIntro}`}>
            <Link className={styles.backLink} href="/blog">
              ← All articles
            </Link>
            <p className={styles.eyebrow}>{post.category}</p>
            <h1>{post.title}</h1>
            <p className={styles.lead}>{post.description}</p>
            <div className={styles.meta}>
              <Link href="/about">Tidy</Link>
              <time dateTime={post.date}>{formatPostDate(post.date)}</time>
              <span>{post.readingMinutes} min read</span>
            </div>
            {post.updated && (
              <p className={styles.updated}>
                Updated <time dateTime={post.updated}>{formatPostDate(post.updated)}</time>
              </p>
            )}
          </header>
          <PostImage post={post} hero />
          <div className={styles.prose}>
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                a: ({ href, children }) =>
                  href?.startsWith("/") && !href.startsWith("//") ? (
                    <Link href={href}>{children}</Link>
                  ) : (
                    <a href={href}>{children}</a>
                  ),
                table: ({ children }) => (
                  <div
                    className={styles.tableScroll}
                    tabIndex={0}
                    role="region"
                    aria-label="Article table"
                  >
                    <table>{children}</table>
                  </div>
                ),
              }}
            >
              {post.body}
            </Markdown>
          </div>
        </article>
        {related.length > 0 && (
          <section className={styles.related} aria-labelledby="related-title">
            <h2 id="related-title">Keep exploring.</h2>
            <PostList posts={related} />
          </section>
        )}
      </main>
      <CloudFooter appUrl={appUrl} repositoryUrl={repositoryUrl} />
    </>
  );
}

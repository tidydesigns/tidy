import { CloudFooter } from "../../components/brand/cloud-footer";
import { PostList } from "../../components/editorial/post-list";
import { StructuredData } from "../../components/structured-data";
import { getPosts } from "../../lib/blog";
import { pageMetadata } from "../../lib/page-metadata";
import { appUrl, repositoryUrl } from "../../lib/site-links";
import { siteUrl } from "../../lib/site-url";
import styles from "../../components/editorial/editorial.module.css";

export const metadata = pageMetadata(
  "/blog",
  "Tidy blog | Design, code and AI workflows",
  "Practical notes on design-to-code workflows, open-source design tools and working with coding agents. Ideas for making better products with Tidy.",
);

export default async function BlogPage() {
  const posts = await getPosts();
  return (
    <>
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "Blog",
          name: "Tidy blog",
          url: new URL("/blog", siteUrl).href,
          blogPost: posts.map((post) => ({
            "@type": "BlogPosting",
            headline: post.title,
            url: new URL(`/blog/${post.slug}`, siteUrl).href,
            datePublished: post.date,
          })),
        }}
      />
      <main id="main-content" tabIndex={-1} className={styles.page}>
        <header className={styles.intro}>
          <p className={styles.eyebrow}>The Tidy blog</p>
          <h1>
            Ideas for making
            <br />
            better products.
          </h1>
          <p className={styles.lead}>Design, engineering, and the space between.</p>
        </header>
        <PostList posts={posts} />
      </main>
      <CloudFooter appUrl={appUrl} repositoryUrl={repositoryUrl} />
    </>
  );
}

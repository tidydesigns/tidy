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
  "Guides to using Tidy’s design canvas, coding agents and local projects, including design-to-code workflows and MCP tools.",
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
          <h1>Tidy blog.</h1>
          <p className={styles.lead}>How to use Tidy’s canvas, coding agents and local projects.</p>
        </header>
        <PostList posts={posts} />
      </main>
      <CloudFooter appUrl={appUrl} repositoryUrl={repositoryUrl} />
    </>
  );
}

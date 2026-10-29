import Link from "next/link";
import { getPosts } from "../../lib/blog";
import { PostList } from "./post-list";
import styles from "./editorial.module.css";

export async function HomeEditorial() {
  const posts = (await getPosts()).slice(0, 2);
  if (!posts.length) return null;
  return (
    <section className={styles.homeSection} aria-labelledby="home-blog-title">
      <div className={styles.homeHeading}>
        <h2 id="home-blog-title">From the blog.</h2>
        <Link className={styles.textLink} href="/blog">
          All articles <span aria-hidden="true">→</span>
        </Link>
      </div>
      <PostList posts={posts} headingLevel={3} />
    </section>
  );
}

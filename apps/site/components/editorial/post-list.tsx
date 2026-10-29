import Link from "next/link";
import { PostImage } from "./post-image";
import { formatPostDate, type BlogPost } from "../../lib/blog";
import styles from "./editorial.module.css";

export function PostList({ posts, headingLevel = 2 }: { posts: BlogPost[]; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <div className={styles.posts}>
      {posts.map((post) => (
        <article key={post.slug}>
          <Link
            className={styles.postLink}
            href={`/blog/${post.slug}`}
            aria-labelledby={`post-${post.slug}`}
          >
            <PostImage post={post} />
            <div className={styles.postSummary}>
              <span className={styles.eyebrow}>{post.category}</span>
              <Heading id={`post-${post.slug}`} className={styles.postTitle}>
                {post.title}
              </Heading>
              <p>{post.description}</p>
              <span className={styles.meta}>
                <time dateTime={post.date}>{formatPostDate(post.date)}</time>
                <span>{post.readingMinutes} min read</span>
              </span>
            </div>
            <span className={styles.arrow} aria-hidden="true">
              ↗
            </span>
          </Link>
        </article>
      ))}
    </div>
  );
}

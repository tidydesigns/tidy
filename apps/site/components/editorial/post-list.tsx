import Link from "next/link";
import { CloudArtwork } from "../brand/cloud-artwork";
import { formatPostDate, type BlogPost } from "../../lib/blog";
import styles from "./editorial.module.css";

export function PostList({ posts }: { posts: BlogPost[] }) {
  return (
    <div className={styles.posts}>
      {posts.map((post) => (
        <article key={post.slug}>
          <Link className={styles.postLink} href={`/blog/${post.slug}`}>
            <div className={styles.postArtwork} data-artwork={post.artwork} aria-hidden="true">
              <CloudArtwork name={post.artwork} sizes="(max-width: 640px) 90vw, 280px" />
            </div>
            <div className={styles.postSummary}>
              <span className={styles.eyebrow}>{post.category}</span>
              <h2>{post.title}</h2>
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

import Image from "next/image";
import Link from "next/link";
import { founders } from "../../content/founders";
import { getPosts } from "../../lib/blog";
import { PostList } from "./post-list";
import styles from "./editorial.module.css";

export async function HomeEditorial() {
  const posts = (await getPosts()).slice(0, 2);
  return (
    <>
      {posts.length > 0 && (
        <section className={styles.homeSection} aria-labelledby="home-blog-title">
          <div className={styles.homeHeading}>
            <div>
              <p className={styles.eyebrow}>From the blog</p>
              <h2 id="home-blog-title">A few things we’re thinking about.</h2>
            </div>
            <Link className={styles.textLink} href="/blog">
              All articles <span aria-hidden="true">→</span>
            </Link>
          </div>
          <PostList posts={posts} />
        </section>
      )}
      <section
        className={`${styles.homeSection} ${styles.homeAbout}`}
        aria-labelledby="home-about-title"
      >
        <div>
          <p className={styles.eyebrow}>The people behind Tidy</p>
          <h2 id="home-about-title">Built by Sean and Tadhg.</h2>
          <p>
            We’re making an open-source workspace for the whole journey from an idea to a working
            product.
          </p>
          <Link className={styles.textLink} href="/about">
            Meet the founders <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div className={styles.homePortraits}>
          {founders.map((founder) => (
            <Image
              key={founder.id}
              src={founder.image}
              alt={founder.name}
              width={640}
              height={640}
              unoptimized
            />
          ))}
        </div>
      </section>
    </>
  );
}

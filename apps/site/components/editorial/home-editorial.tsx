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
            <h2 id="home-blog-title">From the blog.</h2>
            <Link className={styles.textLink} href="/blog">
              All articles <span aria-hidden="true">→</span>
            </Link>
          </div>
          <PostList posts={posts} headingLevel={3} />
        </section>
      )}
      <section
        className={`${styles.homeSection} ${styles.homeAbout}`}
        aria-labelledby="home-about-title"
      >
        <div>
          <h2 id="home-about-title">Built by Sean and Tadhg.</h2>
          <p>
            We’re building Tidy: a browser design canvas and a Mac app for working with designs,
            code and coding agents.
          </p>
          <Link className={styles.textLink} href="/about">
            About Tidy <span aria-hidden="true">→</span>
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

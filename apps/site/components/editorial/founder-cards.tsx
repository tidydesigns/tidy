import Image from "next/image";
import { founders } from "../../content/founders";
import { BrandIcon } from "../brand/brand-icon";
import styles from "./editorial.module.css";

export function FounderCards() {
  return (
    <div className={styles.founders}>
      {founders.map((founder) => (
        <article key={founder.id} id={founder.id} className={styles.founder}>
          <Image
            src={founder.image}
            width={640}
            height={640}
            alt={founder.name}
            unoptimized
            className={styles.portrait}
          />
          <div className={styles.founderInfo}>
            <div>
              <h3>{founder.name}</h3>
              <p>Co-founder</p>
            </div>
            <div className={styles.socials}>
              <a href={founder.github} aria-label={`${founder.name} on GitHub`}>
                <BrandIcon name="github" />
                GitHub
              </a>
              <a href={founder.linkedin} aria-label={`${founder.name} on LinkedIn`}>
                LinkedIn <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

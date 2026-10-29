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
            <h3>{founder.name}</h3>
            <div className={styles.socials}>
              <a href={founder.github} aria-label={`${founder.name} on GitHub`}>
                <BrandIcon name="github" />
                <span>GitHub</span>
              </a>
              <a href={founder.linkedin} aria-label={`${founder.name} on LinkedIn`}>
                <span>LinkedIn</span>
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

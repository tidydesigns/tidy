import Image from "next/image";
import { founders } from "../../content/founders";
import { BrandIcon } from "../brand/brand-icon";
import styles from "./editorial.module.css";

export function FounderCards() {
  return (
    <div className={styles.founders}>
      {founders.map((founder) => (
        <article key={founder.id} id={founder.id} className={styles.founder}>
          <picture>
            <source
              srcSet={`${founder.imageSmall} 560w, ${founder.image} 1120w`}
              sizes="(max-width: 640px) calc(100vw - 40px), (max-width: 1184px) calc((100vw - 96px) / 2), 544px"
              type="image/webp"
            />
            <Image
              src={founder.image}
              width={1120}
              height={1120}
              alt={founder.name}
              unoptimized
              className={styles.portrait}
            />
          </picture>
          <div className={styles.founderInfo}>
            <h3>{founder.name}</h3>
            <div className={styles.socials}>
              <a href={founder.github} aria-label={`${founder.name} on GitHub`}>
                <BrandIcon name="github" />
                <span>GitHub</span>
              </a>
              <a href={founder.linkedin} aria-label={`${founder.name} on LinkedIn`}>
                <BrandIcon name="linkedin" />
                <span>LinkedIn</span>
              </a>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

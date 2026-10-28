import { CloudArtwork } from "./cloud-artwork";
import styles from "./cloud-atmosphere.module.css";

// One uninterrupted image treatment, shared by the hero and footer.
export function CloudAtmosphere({ eager = false }: { eager?: boolean }) {
  return (
    <CloudArtwork
      name="cloud-atmosphere"
      sizes="(max-width: 800px) 1200px, 100vw"
      className={styles.atmosphere}
      eager={eager}
    />
  );
}

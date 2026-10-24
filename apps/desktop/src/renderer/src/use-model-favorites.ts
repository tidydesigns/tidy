import { useState } from "react";
import { z } from "zod";

const favoritesKey = "tidy.model-favorites";
const favoritesSchema = z.array(z.string().max(500)).max(500);

function readFavorites(): z.infer<typeof favoritesSchema> {
  try {
    return favoritesSchema.parse(JSON.parse(localStorage.getItem(favoritesKey) ?? "[]"));
  } catch {
    return [];
  }
}

export function useModelFavorites() {
  const [favorites, setFavorites] = useState(readFavorites);

  function toggleFavorite(value: string) {
    const next = favorites.includes(value)
      ? favorites.filter((item) => item !== value)
      : [...favorites, value].slice(-500);
    setFavorites(next);
    try {
      localStorage.setItem(favoritesKey, JSON.stringify(next));
    } catch {}
  }

  return { favorites, toggleFavorite };
}

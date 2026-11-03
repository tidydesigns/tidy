import { z } from "zod";

const controlCharactersPattern = /[\u0000-\u001f\u007f]/;

export const profileNameSchema = z
  .string()
  .trim()
  .min(1, "Enter your name.")
  .max(100, "Use 100 characters or fewer.")
  .refine((name) => !controlCharactersPattern.test(name), "Use a name without control characters.");

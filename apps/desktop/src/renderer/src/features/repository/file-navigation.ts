import { createContext } from "react";

export const FileNavigationContext = createContext<((href: string) => void) | null>(null);
export type FileNavigationRequest = { id: string; href: string };
export type FileLineTarget = {
  id: string;
  path: string;
  line: number;
  column?: number;
  endLine?: number;
};

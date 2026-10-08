"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const OrganizationNamesContext = createContext<{
  images: Record<string, string | null>;
  updateImage: (id: string, image: string | null) => void;
  pendingImages: Record<string, boolean>;
  setImagePending: (id: string, pending: boolean) => void;
  names: Record<string, string>;
  updateName: (id: string, name: string) => void;
  profileName: string | null;
  updateProfileName: (name: string) => void;
} | null>(null);

export function OrganizationNamesProvider({ children }: { children: ReactNode }) {
  const [pendingImages, setPendingImages] = useState<Record<string, boolean>>({});
  const setImagePending = useCallback((id: string, pending: boolean) => {
    setPendingImages((current) => ({ ...current, [id]: pending }));
  }, []);
  const [images, setImages] = useState<Record<string, string | null>>({});
  const updateImage = useCallback((id: string, image: string | null) => {
    setImages((current) => ({ ...current, [id]: image }));
  }, []);
  const [names, setNames] = useState<Record<string, string>>({});
  const [profileName, updateProfileName] = useState<string | null>(null);
  const updateName = useCallback((id: string, name: string) => {
    setNames((current) => ({ ...current, [id]: name }));
  }, []);

  return (
    <OrganizationNamesContext.Provider
      value={{
        images,
        updateImage,
        pendingImages,
        setImagePending,
        names,
        updateName,
        profileName,
        updateProfileName,
      }}
    >
      {children}
    </OrganizationNamesContext.Provider>
  );
}

export function useOrganizationNames() {
  const context = useContext(OrganizationNamesContext);
  if (!context) throw new Error("Organization names require a workspace provider.");
  return context;
}

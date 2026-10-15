export function clearAnalyticsStorage() {
  try {
    const names = document.cookie
      .split(";")
      .map((part) => part.trim().split("=")[0])
      .filter((name) => name.startsWith("ph_"));
    const parts = location.hostname.split(".");
    for (const name of names) {
      document.cookie = `${name}=; Path=/; Max-Age=0`;
      for (let index = 0; index < parts.length - 1; index++)
        document.cookie = `${name}=; Path=/; Max-Age=0; Domain=.${parts.slice(index).join(".")}`;
    }
  } catch {
    /* Storage can be unavailable. */
  }
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      const store = storage();
      for (const name of Object.keys(store))
        if (name.startsWith("ph_") || name.startsWith("__ph_opt_in_out_")) store.removeItem(name);
    } catch {
      /* Authentication and functional preferences are left intact. */
    }
  }
}
